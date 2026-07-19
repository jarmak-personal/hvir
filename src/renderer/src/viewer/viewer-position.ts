import type { ViewMode } from '../../../shared'
import type { ViewerDocumentPosition } from './tab-state'

export interface ViewerPositionCapture {
  current: (() => ViewerDocumentPosition) | undefined
}

export interface RenderedSourceAnchor {
  readonly line: number
  readonly top: number
}

export function initialViewerPosition(mode: ViewMode): ViewerDocumentPosition {
  return { mode, line: 1, scrollTop: 0 }
}

export function nextViewerMode(mode: ViewMode): ViewMode {
  if (mode === 'rendered') return 'source'
  if (mode === 'source') return 'diff'
  return 'rendered'
}

export function documentLineCount(content: string): number {
  let lines = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

export function approximateLineAtScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  lineCount: number,
): number {
  const boundedLines = Math.max(1, Math.floor(lineCount))
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  if (maxScroll === 0 || boundedLines === 1) return 1
  const progress = Math.min(1, Math.max(0, scrollTop / maxScroll))
  return Math.round(progress * (boundedLines - 1)) + 1
}

export function approximateScrollForLine(
  line: number,
  scrollHeight: number,
  clientHeight: number,
  lineCount: number,
): number {
  const boundedLines = Math.max(1, Math.floor(lineCount))
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  if (maxScroll === 0 || boundedLines === 1) return 0
  const boundedLine = Math.min(boundedLines, Math.max(1, Math.floor(line)))
  return ((boundedLine - 1) / (boundedLines - 1)) * maxScroll
}

export function nearestSourceAnchor(
  anchors: readonly RenderedSourceAnchor[],
  line: number,
): RenderedSourceAnchor | undefined {
  const target = Math.max(1, Math.floor(line))
  let nearest: RenderedSourceAnchor | undefined
  for (const anchor of anchors) {
    if (anchor.line > target) continue
    if (!nearest || anchor.line > nearest.line || anchor.top > nearest.top)
      nearest = anchor
  }
  return (
    nearest ??
    anchors.reduce<RenderedSourceAnchor | undefined>((first, anchor) => {
      if (!first || anchor.line < first.line || anchor.top < first.top) return anchor
      return first
    }, undefined)
  )
}
