import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { FindMatchIndex } from './find-match-index'
import type { ViewerFindRange } from './viewer-find'

export const setFindDecorations = StateEffect.define<{
  readonly matches?: FindMatchIndex
  readonly active?: ViewerFindRange
}>()
const continueDecorations = StateEffect.define<null>()
const matchMark = Decoration.mark({ class: 'cm-hvir-find-match' })
const activeMark = Decoration.mark({ class: 'cm-hvir-find-match-active' })
const findState = StateField.define<{
  readonly matches?: FindMatchIndex
  readonly active?: ViewerFindRange
}>({
  create: () => ({}),
  update(value, transaction) {
    if (transaction.docChanged) value = {}
    for (const effect of transaction.effects) {
      if (effect.is(setFindDecorations)) value = effect.value
    }
    return value
  },
  provide: (field) =>
    EditorView.decorations.from(field, ({ active }) =>
      active
        ? Decoration.set([activeMark.range(active.from, active.to)])
        : Decoration.none,
    ),
})

/** Only visible matches are materialized, in bounded turns even for dense long lines.
 * Active navigation changes one mark without restarting the viewport's decoration work. */
export const viewerFindDecorations = [
  findState,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      #timer?: ReturnType<typeof setTimeout>
      #visible: readonly ViewerFindRange[] = []
      #range = 0
      #match = 0
      constructor(view: EditorView) {
        this.#restart(view)
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.startState.field(findState).matches !==
            update.state.field(findState).matches
        ) {
          this.#restart(update.view)
        } else if (
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(continueDecorations)),
          )
        ) {
          this.#advance(update.view)
        }
      }
      #restart(view: EditorView): void {
        clearTimeout(this.#timer)
        this.decorations = Decoration.none
        this.#visible = view.visibleRanges
        this.#range = 0
        this.#match = 0
        this.#advance(view)
      }
      #advance(view: EditorView): void {
        const { matches } = view.state.field(findState)
        if (!matches) return
        const additions = []
        let remaining = 2000
        while (this.#range < this.#visible.length && remaining > 0) {
          const visible = this.#visible[this.#range]!
          if (this.#match === 0) this.#match = matches.firstEndingAfter(visible.from)
          while (this.#match < matches.length && remaining > 0) {
            const match = matches.at(this.#match)
            if (match.from >= visible.to) break
            additions.push(matchMark.range(match.from, match.to))
            this.#match++
            remaining--
          }
          if (remaining > 0) {
            this.#range++
            this.#match = 0
          }
        }
        this.decorations = this.decorations.update({ add: additions, sort: true })
        if (this.#range < this.#visible.length) {
          this.#timer = setTimeout(
            () => view.dispatch({ effects: continueDecorations.of(null) }),
            0,
          )
        }
      }
      destroy(): void {
        clearTimeout(this.#timer)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
]
