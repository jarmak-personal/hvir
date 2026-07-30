import type { EditorView } from '@codemirror/view'

export function captureTopLine(view: EditorView, scrollRoot: HTMLElement): number {
  const rootBounds = scrollRoot.getBoundingClientRect()
  const visibleMarker = [
    ...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
  ]
    .filter((node) => /^[0-9]+$/.test(node.textContent?.trim() ?? ''))
    .sort(
      (left, right) =>
        left.getBoundingClientRect().top - right.getBoundingClientRect().top,
    )
    .find((node) => node.getBoundingClientRect().bottom > rootBounds.top + 1)
  if (visibleMarker) return Number(visibleMarker.textContent?.trim())

  const contentBounds = view.contentDOM.getBoundingClientRect()
  const position = view.posAtCoords(
    {
      x: Math.min(contentBounds.right - 1, contentBounds.left + 8),
      y: rootBounds.top + 1,
    },
    false,
  )
  return view.state.doc.lineAt(position ?? 0).number
}

export function restoreTopLine(
  view: EditorView,
  scrollRoot: HTMLElement,
  lineNumber: number,
): void {
  const line = view.state.doc.line(
    Math.min(view.state.doc.lines, Math.max(1, Math.floor(lineNumber))),
  )
  view.requestMeasure({
    read: (measuredView) => ({
      blockTop: measuredView.lineBlockAt(line.from).top,
      paddingTop: measuredView.documentPadding.top,
    }),
    write: ({ blockTop, paddingTop }) => {
      scrollRoot.scrollTop = paddingTop + blockTop
    },
  })
}

export function restoreScrollTop(
  view: EditorView,
  scrollRoot: HTMLElement,
  scrollTop: number,
): void {
  view.requestMeasure({
    read: () => Math.max(0, scrollTop),
    write: (measuredScrollTop) => {
      scrollRoot.scrollTop = measuredScrollTop
    },
  })
}
