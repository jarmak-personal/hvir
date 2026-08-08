import type { DocumentReviewComment, ReviewSourceRange } from './document-review-types'

const GENERATED_ATTRIBUTE = 'data-hvir-review-generated'
const SOURCE_LINE_ATTRIBUTE = 'data-source-line'
const SOURCE_END_LINE_ATTRIBUTE = 'data-source-end-line'
const BLOCKS_PER_FRAME = 100
let nextBindingId = 0

export interface RenderedReviewProjection {
  readonly active: boolean
  readonly dirty: boolean
  readonly comments: readonly DocumentReviewComment[]
  readonly inlineRange?: ReviewSourceRange
  readonly onInlineHost: (host: HTMLElement) => () => void
  readonly onCapture: (range: ReviewSourceRange) => void
  readonly onOpenComment: (comment: DocumentReviewComment) => void
  readonly onExit: () => void
}

export interface RenderedReviewScheduler {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

export function bindRenderedDocumentReview(
  root: HTMLElement,
  projection: RenderedReviewProjection,
  scheduler: RenderedReviewScheduler = browserFrameScheduler,
): () => void {
  if (!projection.active && projection.comments.length === 0) return () => undefined

  const blocks: HTMLElement[] = []
  const blockIndexes = new WeakMap<HTMLElement, number>()
  const generated: Array<HTMLElement | undefined> = []
  const bindingId = String(++nextBindingId)
  const children = root.children
  let index = 0
  let disposed = false
  let frame = 0
  let inlineHost:
    { readonly element: HTMLElement; readonly unregister: () => void } | undefined
  const maximumCommentLine = Math.max(
    0,
    ...projection.comments.map((comment) => comment.anchor.range.endLine),
  )

  const process = (): void => {
    if (disposed) return
    const end = Math.min(children.length, index + BLOCKS_PER_FRAME)
    while (index < end) {
      const element = children.item(index++)
      if (!(element instanceof HTMLElement)) continue
      const range = renderedReviewBlockRange(element)
      if (!range) continue
      if (!projection.active && range.startLine > maximumCommentLine) {
        index = children.length
        break
      }
      prepareBlock(element, range, projection, blocks, blockIndexes, generated, bindingId)
      if (
        !inlineHost &&
        projection.inlineRange &&
        rangesOverlap(range, projection.inlineRange)
      ) {
        const host = document.createElement('div')
        host.className =
          'document-review-inline-host document-review-inline-host-rendered'
        host.setAttribute('data-review-inline-host', '')
        element.after(host)
        inlineHost = { element: host, unregister: projection.onInlineHost(host) }
      }
    }
    if (index < children.length) frame = scheduler.request(process)
  }

  const onClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const badge = target.closest<HTMLButtonElement>('[data-review-comment]')
    if (badge && root.contains(badge)) {
      const comment = projection.comments.find(
        (candidate) => candidate.id === badge.dataset.reviewComment,
      )
      if (!comment) return
      event.preventDefault()
      event.stopPropagation()
      projection.onOpenComment(comment)
      return
    }
    const button = target.closest<HTMLButtonElement>('[data-review-capture]')
    if (!button || !root.contains(button)) return
    const block = button.closest<HTMLElement>(`[${SOURCE_LINE_ATTRIBUTE}]`)
    const range = block && renderedReviewBlockRange(block)
    if (!range) return
    event.preventDefault()
    event.stopPropagation()
    projection.onCapture(range)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!projection.active) return
    if (
      event.target instanceof Element &&
      event.target.closest('[data-review-inline-host]')
    ) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      projection.onExit()
      return
    }
    const block = event.target
    if (!(block instanceof HTMLElement)) return
    const current = blockIndexes.get(block)
    if (current === undefined) return
    if (event.key === 'Enter' && !projection.dirty) {
      const range = renderedReviewBlockRange(block)
      if (range) {
        event.preventDefault()
        projection.onCapture(range)
      }
      return
    }
    const destination =
      event.key === 'ArrowDown'
        ? blocks[current + 1]
        : event.key === 'ArrowUp'
          ? blocks[current - 1]
          : event.key === 'Home'
            ? blocks[0]
            : event.key === 'End'
              ? blocks.at(-1)
              : undefined
    if (!destination) return
    event.preventDefault()
    destination.focus()
  }

  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKeyDown)
  frame = scheduler.request(process)
  return () => {
    disposed = true
    scheduler.cancel(frame)
    root.removeEventListener('click', onClick)
    root.removeEventListener('keydown', onKeyDown)
    inlineHost?.unregister()
    inlineHost?.element.remove()
    let cleanupIndex = 0
    const cleanup = (): void => {
      const end = Math.min(blocks.length, cleanupIndex + BLOCKS_PER_FRAME)
      while (cleanupIndex < end) {
        const block = blocks[cleanupIndex]
        const generatedElement = generated[cleanupIndex]
        cleanupIndex += 1
        generatedElement?.remove()
        if (!block || block.getAttribute('data-review-binding') !== bindingId) continue
        block.classList.remove(
          'review-block',
          'review-block-active',
          'review-block-noted',
        )
        block.removeAttribute('data-review-anchor-state')
        block.removeAttribute('data-review-binding')
        block.removeAttribute('tabindex')
        block.removeAttribute('aria-label')
      }
      if (cleanupIndex < blocks.length) scheduler.request(cleanup)
    }
    cleanup()
  }
}

export function renderedReviewBlockRange(
  element: Element,
): ReviewSourceRange | undefined {
  const startLine = Number(element.getAttribute(SOURCE_LINE_ATTRIBUTE))
  const endLine = Number(element.getAttribute(SOURCE_END_LINE_ATTRIBUTE))
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return undefined
  }
  return { startLine, endLine }
}

function prepareBlock(
  block: HTMLElement,
  range: ReviewSourceRange,
  projection: RenderedReviewProjection,
  blocks: HTMLElement[],
  blockIndexes: WeakMap<HTMLElement, number>,
  generated: Array<HTMLElement | undefined>,
  bindingId: string,
): void {
  const comments = projection.comments.filter((comment) =>
    rangesOverlap(range, comment.anchor.range),
  )
  if (!projection.active && comments.length === 0) return
  block.classList.add('review-block')
  block.setAttribute('data-review-binding', bindingId)
  blockIndexes.set(block, blocks.length)
  blocks.push(block)
  let generatedElement: HTMLElement | undefined
  if (projection.active) {
    block.classList.add('review-block-active')
    block.tabIndex = 0
    block.setAttribute(
      'aria-label',
      projection.dirty
        ? `Markdown review block, ${lineRangeLabel(range)}. Save or reload before adding a comment; use arrow keys for adjacent blocks.`
        : `Markdown review block, ${lineRangeLabel(range)}. Press Enter to add a comment; use arrow keys for adjacent blocks.`,
    )
    if (!projection.dirty) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'review-block-add'
      button.textContent = '+'
      button.setAttribute(GENERATED_ATTRIBUTE, '')
      button.setAttribute('data-review-capture', '')
      button.setAttribute('aria-label', `Add comment for ${lineRangeLabel(range)}`)
      block.append(button)
      generatedElement = button
    }
  }
  if (comments.length === 0) {
    generated.push(generatedElement)
    return
  }
  block.classList.add('review-block-noted')
  const anchorStates = [
    ...new Set(comments.map((comment) => comment.anchor.state.status)),
  ]
  block.setAttribute('data-review-anchor-state', anchorStates.join(' '))
  const badge = document.createElement('button')
  badge.type = 'button'
  badge.className = `review-block-badge ${anchorStates
    .map((status) => `review-anchor-${status}`)
    .join(' ')}`
  badge.textContent = comments.some((comment) => comment.anchor.state.status === 'stale')
    ? `! ${comments.length}`
    : comments.some((comment) => comment.anchor.state.status === 'moved')
      ? `↗ ${comments.length}`
      : String(comments.length)
  badge.setAttribute(GENERATED_ATTRIBUTE, '')
  badge.dataset.reviewComment = comments[0]!.id
  badge.setAttribute(
    'aria-label',
    `Open ${comments.length} review ${comments.length === 1 ? 'note' : 'notes'} at ${lineRangeLabel(range)}; ${anchorStates.join(', ')}`,
  )
  block.append(badge)
  if (generatedElement) {
    const group = document.createElement('span')
    group.className = 'review-block-controls'
    group.setAttribute(GENERATED_ATTRIBUTE, '')
    generatedElement.before(group)
    group.append(generatedElement, badge)
    generatedElement = group
  } else {
    generatedElement = badge
  }
  generated.push(generatedElement)
}

function rangesOverlap(left: ReviewSourceRange, right: ReviewSourceRange): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}

function lineRangeLabel(range: ReviewSourceRange): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}–${range.endLine}`
}

const browserFrameScheduler: RenderedReviewScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
}
