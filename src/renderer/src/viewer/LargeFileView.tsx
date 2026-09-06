import { useEffect, useRef, type ReactElement } from 'react'
import type { ViewMode } from '../../../shared'
import { DomFindTarget } from './dom-find-target'
import { resolveSourceCoordinate } from './source-coordinate'
import type { ViewerDocumentPosition, ViewerNavigationPosition } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import {
  approximateLineAtScroll,
  approximateScrollForLine,
  documentLineCount,
  type ViewerPositionCapture,
} from './viewer-position'
import { sourcePreview } from './viewer-workload-policy'
import { formatViewerBytes } from './viewer-byte-format'

export function LargeFileView({
  content,
  size,
  mode,
  position,
  onPosition,
  positionCapture,
  navigation,
  onNavigationHandled,
  registerFindTarget,
}: {
  readonly content: string
  readonly size: number
  readonly mode: ViewMode
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly navigation?: ViewerNavigationPosition
  readonly onNavigationHandled: (serial: number) => void
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const container = useRef<HTMLPreElement>(null)
  const positionRef = useRef(position)
  const onPositionRef = useRef(onPosition)
  const preview = sourcePreview(content)
  const lines = documentLineCount(preview)
  positionRef.current = position
  onPositionRef.current = onPosition
  useEffect(() => {
    const root = container.current
    if (!root) return
    const capture = (): ViewerDocumentPosition => ({
      mode,
      line: approximateLineAtScroll(
        root.scrollTop,
        root.scrollHeight,
        root.clientHeight,
        lines,
      ),
      scrollTop: root.scrollTop,
    })
    const handleScroll = (): void => onPositionRef.current(capture())
    positionCapture.current = capture
    root.addEventListener('scroll', handleScroll, { passive: true })
    const restoreFrame = requestAnimationFrame(() => {
      const restorePosition = positionRef.current
      root.scrollTop =
        restorePosition.mode === mode
          ? restorePosition.scrollTop
          : approximateScrollForLine(
              restorePosition.line,
              root.scrollHeight,
              root.clientHeight,
              lines,
            )
    })
    return () => {
      cancelAnimationFrame(restoreFrame)
      root.removeEventListener('scroll', handleScroll)
      if (positionCapture.current === capture) positionCapture.current = undefined
    }
  }, [lines, mode, positionCapture])

  useEffect(() => {
    if (!navigation) return
    const frame = requestAnimationFrame(() => {
      const root = container.current
      if (!root) return
      const resolved = resolveSourceCoordinate(preview, navigation)
      if (resolved.valid) {
        const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight)
        if (Number.isFinite(lineHeight)) {
          root.scrollTop = Math.max(
            0,
            (resolved.coordinate.line - 1) * lineHeight - root.clientHeight / 2,
          )
        } else {
          root.scrollTop = approximateScrollForLine(
            resolved.coordinate.line,
            root.scrollHeight,
            root.clientHeight,
            lines,
          )
        }
        const text = root.firstChild
        if (text instanceof Text && resolved.offset <= text.length) {
          const range = document.createRange()
          range.setStart(text, resolved.offset)
          range.collapse(true)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        if (navigation.focus) root.focus()
      }
      onNavigationHandled(navigation.serial)
    })
    return () => cancelAnimationFrame(frame)
  }, [lines, navigation, onNavigationHandled, preview])

  useEffect(() => {
    const root = container.current
    if (!root) return
    const target = new DomFindTarget(root)
    const unregister = registerFindTarget(target)
    return () => {
      unregister()
      target.dispose()
    }
  }, [preview, registerFindTarget])
  return (
    <div className="large-file-shell">
      <div className="source-meta">
        <span>{formatViewerBytes(size)}</span>
        <span>read-only preview · first {formatViewerBytes(preview.length)}</span>
      </div>
      <pre ref={container} className="large-file-preview" tabIndex={-1}>
        {preview}
      </pre>
    </div>
  )
}
