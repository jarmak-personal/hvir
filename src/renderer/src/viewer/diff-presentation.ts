import { getChunks } from '@codemirror/merge'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/** Boundaries locate separate edits without inserting text or changing line heights. */
export const diffGroupBoundaries = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = groupBoundaries(view)
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks
      ) {
        this.decorations = groupBoundaries(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

function groupBoundaries(view: EditorView): DecorationSet {
  const result = getChunks(view.state)
  if (!result) return Decoration.none
  const ranges = []
  for (const chunk of result.chunks) {
    const from = result.side === 'a' ? chunk.fromA : chunk.fromB
    const to = result.side === 'a' ? chunk.toA : chunk.toB
    if (from === to) continue
    const first = view.state.doc.lineAt(Math.min(from, view.state.doc.length)).from
    const last = view.state.doc.lineAt(Math.min(to - 1, view.state.doc.length)).from
    if (first >= view.viewport.from && first <= view.viewport.to) {
      ranges.push(Decoration.line({ class: 'cm-diff-group-start' }).range(first))
    }
    if (last >= view.viewport.from && last <= view.viewport.to) {
      ranges.push(Decoration.line({ class: 'cm-diff-group-end' }).range(last))
    }
  }
  return Decoration.set(ranges, true)
}

/** Preserve MergeView's expansion behavior while making its widgets keyboard reachable. */
export function registerDiffContextControls(root: HTMLElement): () => void {
  const exposeControls = (): void => {
    for (const control of root.querySelectorAll<HTMLElement>('.cm-collapsedLines')) {
      control.setAttribute('role', 'button')
      control.tabIndex = 0
      control.setAttribute(
        'aria-label',
        `Expand ${control.textContent ?? 'unchanged lines'}`,
      )
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.target instanceof HTMLElement &&
      event.target.classList.contains('cm-collapsedLines') &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault()
      event.target.click()
    }
  }
  const observer = new MutationObserver(exposeControls)
  observer.observe(root, { childList: true, subtree: true })
  root.addEventListener('keydown', onKeyDown)
  exposeControls()
  return () => {
    observer.disconnect()
    root.removeEventListener('keydown', onKeyDown)
  }
}

export function diffTheme(theme: 'dark' | 'light') {
  return EditorView.theme(
    {
      '&': { height: '100%', backgroundColor: 'var(--viewer-bg)', color: 'var(--text)' },
      '.cm-scroller': {
        fontFamily: 'var(--hvir-monospace-font)',
        fontSize: 'calc(12px * var(--hvir-interface-scale))',
        lineHeight: '1.65',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--viewer-gutter)',
        borderRight: '1px solid var(--code-border)',
        color: 'var(--viewer-gutter-text)',
      },
    },
    { dark: theme === 'dark' },
  )
}
