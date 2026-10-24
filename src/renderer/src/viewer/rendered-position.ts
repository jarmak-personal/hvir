import type { ViewerDocumentPosition } from './tab-state'
import { approximateLineAtScroll, approximateScrollForLine } from './viewer-position'

const MAX_POSITION_ANCHORS = 4096
interface SourceElement {
  readonly element: HTMLElement
  readonly line: number
}

export function captureRenderedPosition(
  root: HTMLElement,
  lineCount: number,
): ViewerDocumentPosition {
  const anchors = sourceElements(root)
  const viewportTop = root.getBoundingClientRect().top + 1
  // Source anchors follow document order. Read only logarithmically many live
  // geometries; image/diagram resizing therefore needs no stale geometry cache.
  let low = 0
  let high = anchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (anchors[middle]!.element.getBoundingClientRect().top <= viewportTop)
      low = middle + 1
    else high = middle
  }
  return {
    mode: 'rendered',
    line:
      anchors[low - 1]?.line ??
      approximateLineAtScroll(
        root.scrollTop,
        root.scrollHeight,
        root.clientHeight,
        lineCount,
      ),
    scrollTop: root.scrollTop,
  }
}

export function restoreRenderedPosition(
  root: HTMLElement,
  position: ViewerDocumentPosition,
  lineCount: number,
): void {
  if (position.mode === 'rendered') {
    root.scrollTop = position.scrollTop
    return
  }
  const anchors = sourceElements(root)
  let nearest: SourceElement | undefined
  for (const anchor of anchors) {
    if (anchor.line <= position.line && (!nearest || anchor.line >= nearest.line))
      nearest = anchor
  }
  nearest ??= anchors[0]
  root.scrollTop = nearest
    ? root.scrollTop +
      nearest.element.getBoundingClientRect().top -
      root.getBoundingClientRect().top
    : approximateScrollForLine(
        position.line,
        root.scrollHeight,
        root.clientHeight,
        lineCount,
      )
}

function sourceElements(root: HTMLElement): readonly SourceElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('[data-source-line]')
  const stride = Math.max(1, Math.ceil(nodes.length / MAX_POSITION_ANCHORS))
  const anchors: SourceElement[] = []
  for (let index = 0; index < nodes.length; index += stride) {
    const element = nodes[index]!
    const line = Number(element.dataset.sourceLine)
    if (Number.isFinite(line) && line >= 1)
      anchors.push({ element, line: Math.floor(line) })
  }
  return anchors
}
