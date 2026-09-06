import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { HostPath } from '../../../shared/host-path'
import type { HighlightToken } from './highlight-protocol'
import { requestSourceHighlight } from './highlight-request'
import { getHighlightWorker } from './highlight-worker'

const addTokens = StateEffect.define<readonly HighlightToken[]>()
export const resetTokens = StateEffect.define<null>()
export const tokenDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(resetTokens)) next = Decoration.none
      if (!effect.is(addTokens)) continue
      const additions = effect.value
        .filter(
          (token) =>
            token.from >= 0 &&
            token.to > token.from &&
            token.to <= transaction.state.doc.length,
        )
        .map((token) =>
          Decoration.mark({ attributes: { style: tokenStyle(token) } }).range(
            token.from,
            token.to,
          ),
        )
      next = next.update({ add: additions, sort: true })
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function highlightSource(
  view: EditorView,
  path: HostPath,
  content: string,
  size: number,
  theme: 'dark' | 'light',
  setStatus: (status: string) => void,
): () => void {
  view.dispatch({ effects: resetTokens.of(null) })
  return requestSourceHighlight(
    getHighlightWorker,
    { path, content, size, theme },
    {
      status: setStatus,
      tokens: (tokens) => view.dispatch({ effects: addTokens.of(tokens) }),
    },
  )
}

function tokenStyle(token: HighlightToken): string {
  const declarations: string[] = []
  if (token.color) declarations.push(`color:${token.color}`)
  if (token.backgroundColor)
    declarations.push(`background-color:${token.backgroundColor}`)
  if (token.fontStyle) {
    if ((token.fontStyle & 1) !== 0) declarations.push('font-style:italic')
    if ((token.fontStyle & 2) !== 0) declarations.push('font-weight:700')
    const lines: string[] = []
    if ((token.fontStyle & 4) !== 0) lines.push('underline')
    if ((token.fontStyle & 8) !== 0) lines.push('line-through')
    if (lines.length > 0) declarations.push(`text-decoration:${lines.join(' ')}`)
  }
  return declarations.join(';')
}
