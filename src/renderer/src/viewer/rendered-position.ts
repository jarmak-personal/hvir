import type { ViewerDocumentPosition } from './tab-state'
import {
  approximateLineAtScroll,
  approximateScrollForLine,
  nearestSourceAnchor,
  type RenderedSourceAnchor,
} from './viewer-position'

export function captureRenderedPosition(
  root: HTMLElement,
  lineCount: number,
): ViewerDocumentPosition {
  const anchors = renderedSourceAnchors(root)
  const viewportTop = root.getBoundingClientRect().top + 1
  const visible = anchors.reduce<RenderedSourceAnchor | undefined>((nearest, anchor) => {
    if (anchor.top > viewportTop) return nearest
    return !nearest || anchor.top > nearest.top ? anchor : nearest
  }, undefined)
  return {
    mode: 'rendered',
    line:
      visible?.line ??
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
  const rootTop = root.getBoundingClientRect().top
  const anchor = nearestSourceAnchor(renderedSourceAnchors(root), position.line)
  root.scrollTop = anchor
    ? root.scrollTop + anchor.top - rootTop
    : approximateScrollForLine(
        position.line,
        root.scrollHeight,
        root.clientHeight,
        lineCount,
      )
}

function renderedSourceAnchors(root: HTMLElement): readonly RenderedSourceAnchor[] {
  return [...root.querySelectorAll<HTMLElement>('[data-source-line]')].flatMap(
    (element): RenderedSourceAnchor[] => {
      const line = Number(element.dataset.sourceLine)
      return Number.isFinite(line) && line >= 1
        ? [{ line: Math.floor(line), top: element.getBoundingClientRect().top }]
        : []
    },
  )
}
