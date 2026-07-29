import {
  findLiteralRanges,
  normalizeFindIndex,
  type ViewerFindQuery,
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

let nextHighlightId = 0

export class DomFindTarget implements ViewerFindTarget {
  readonly #activeName: string
  readonly #allName: string
  readonly #listeners = new Set<() => void>()
  readonly #observer: MutationObserver
  readonly #root: HTMLElement
  readonly #style: HTMLStyleElement
  #notifyFrame?: number

  constructor(root: HTMLElement) {
    const id = ++nextHighlightId
    this.#root = root
    this.#allName = `hvir-find-${id}`
    this.#activeName = `hvir-find-active-${id}`
    this.#style = document.createElement('style')
    this.#style.textContent = `
      ::highlight(${this.#allName}) { background: rgb(169 125 33 / 55%); color: inherit; }
      ::highlight(${this.#activeName}) { background: #f4bf4f; color: #11151b; }
    `
    document.head.append(this.#style)
    this.#observer = new MutationObserver(() => this.#scheduleChanged())
    this.#observer.observe(root, { childList: true, characterData: true, subtree: true })
  }

  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult {
    this.clear()
    const text = materializedText(this.#root)
    const matches = findLiteralRanges(text.content, query)
      .map((match) => rangeForMatch(text.segments, match.from, match.to))
      .filter((range): range is Range => Boolean(range))
    if (matches.length === 0) return { current: 0, total: 0 }

    const index = normalizeFindIndex(requestedIndex, matches.length)
    const active = matches[index]
    if (!active) return { current: 0, total: 0 }
    CSS.highlights.set(this.#allName, new Highlight(...matches))
    CSS.highlights.set(this.#activeName, new Highlight(active))
    const target =
      active.startContainer instanceof Element
        ? active.startContainer
        : active.startContainer.parentElement
    target?.scrollIntoView({ block: 'center', inline: 'nearest' })
    return { current: index + 1, total: matches.length }
  }

  clear(): void {
    CSS.highlights.delete(this.#allName)
    CSS.highlights.delete(this.#activeName)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.clear()
    this.#observer.disconnect()
    if (this.#notifyFrame !== undefined) cancelAnimationFrame(this.#notifyFrame)
    this.#style.remove()
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

function rangeForMatch(
  segments: readonly TextSegment[],
  from: number,
  to: number,
): Range | undefined {
  const start = segments.find((segment) => from >= segment.from && from < segment.to)
  const end = segments.find((segment) => to > segment.from && to <= segment.to)
  if (!start || !end) return undefined
  const range = document.createRange()
  range.setStart(start.node, from - start.from)
  range.setEnd(end.node, to - end.from)
  return range
}
