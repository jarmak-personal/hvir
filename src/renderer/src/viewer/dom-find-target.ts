import {
  findLiteralRanges,
  normalizeFindIndex,
  type ViewerFindQuery,
  type ViewerFindRange,
  type ViewerFindResult,
  type ViewerFindTarget,
} from './viewer-find'

interface TextSegment {
  readonly node: Text
  readonly from: number
  readonly to: number
}

interface MaterializedText {
  readonly content: string
  readonly segments: readonly TextSegment[]
}

const ALL_HIGHLIGHT = 'hvir-find-match'
const ACTIVE_HIGHLIGHT = 'hvir-find-active'
const targetMatches = new Map<DomFindTarget, readonly Range[]>()
const targetActiveMatches = new Map<DomFindTarget, Range>()

export class DomFindTarget implements ViewerFindTarget {
  readonly #listeners = new Set<() => void>()
  readonly #observer: MutationObserver
  readonly #root: HTMLElement
  #materialized?: MaterializedText
  #notifyFrame?: number

  constructor(root: HTMLElement) {
    this.#root = root
    this.#observer = new MutationObserver(() => {
      this.#materialized = undefined
      this.#scheduleChanged()
    })
    this.#observer.observe(root, { childList: true, characterData: true, subtree: true })
  }

  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult {
    this.clear()
    const text = (this.#materialized ??= materializedText(this.#root))
    const matches = rangesForMatches(
      text.segments,
      findLiteralRanges(text.content, query),
    )
    if (matches.length === 0) return { current: 0, total: 0 }

    const index = normalizeFindIndex(requestedIndex, matches.length)
    const active = matches[index]
    if (!active) return { current: 0, total: 0 }
    targetMatches.set(this, matches)
    targetActiveMatches.set(this, active)
    syncHighlights()
    const target =
      active.startContainer instanceof Element
        ? active.startContainer
        : active.startContainer.parentElement
    target?.scrollIntoView({ block: 'center', inline: 'nearest' })
    return { current: index + 1, total: matches.length }
  }

  clear(): void {
    targetMatches.delete(this)
    targetActiveMatches.delete(this)
    syncHighlights()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.clear()
    this.#observer.disconnect()
    if (this.#notifyFrame !== undefined) cancelAnimationFrame(this.#notifyFrame)
    this.#listeners.clear()
  }

  #scheduleChanged(): void {
    if (this.#notifyFrame !== undefined) return
    this.#notifyFrame = requestAnimationFrame(() => {
      this.#notifyFrame = undefined
      for (const listener of this.#listeners) listener()
    })
  }
}

function materializedText(root: HTMLElement): MaterializedText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: TextSegment[] = []
  let content = ''
  let previousBlock: Element | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data || !visibleText(node, root)) continue
    const block = textBlock(node, root)
    if (content && block !== previousBlock) content += '\n'
    const from = content.length
    content += node.data
    segments.push({ node, from, to: content.length })
    previousBlock = block
  }
  return { content, segments }
}

function visibleText(node: Text, root: HTMLElement): boolean {
  const parent = node.parentElement
  if (!parent || !root.contains(parent)) return false
  if (parent.closest('script, style, template, [hidden], [aria-hidden="true"]')) {
    return false
  }
  if (typeof parent.checkVisibility === 'function') {
    return parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  const style = getComputedStyle(parent)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function textBlock(node: Text, root: HTMLElement): Element {
  return (
    node.parentElement?.closest(
      'address, article, aside, blockquote, div, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, li, main, nav, p, pre, section, summary, table, td, text, th, tr',
    ) ?? root
  )
}

function rangesForMatches(
  segments: readonly TextSegment[],
  matches: readonly ViewerFindRange[],
): readonly Range[] {
  const ranges: Range[] = []
  let startIndex = 0
  let endIndex = 0
  for (const match of matches) {
    for (;;) {
      const segment = segments[startIndex]
      if (!segment || match.from < segment.to) break
      startIndex++
    }
    const start = segments[startIndex]
    if (!start || match.from < start.from) continue
    endIndex = Math.max(endIndex, startIndex)
    for (;;) {
      const segment = segments[endIndex]
      if (!segment || match.to <= segment.to) break
      endIndex++
    }
    const end = segments[endIndex]
    if (!end || match.to <= end.from) continue
    const range = document.createRange()
    range.setStart(start.node, match.from - start.from)
    range.setEnd(end.node, match.to - end.from)
    ranges.push(range)
  }
  return ranges
}

function syncHighlights(): void {
  const all = new Highlight()
  for (const ranges of targetMatches.values()) {
    for (const range of ranges) all.add(range)
  }
  registerHighlight(ALL_HIGHLIGHT, all)

  const active = new Highlight()
  for (const range of targetActiveMatches.values()) active.add(range)
  registerHighlight(ACTIVE_HIGHLIGHT, active)
}

function registerHighlight(name: string, highlight: Highlight): void {
  if (highlight.size > 0) CSS.highlights.set(name, highlight)
  else CSS.highlights.delete(name)
}
