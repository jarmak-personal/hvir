// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CodeMirrorFindTarget,
  viewerSearch,
} from '../src/renderer/src/viewer/codemirror-find-target'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

describe('CodeMirrorFindTarget', () => {
  it('traverses base then current, wraps, and selects the active match', () => {
    const base = editor('needle base NEEDLE')
    const current = editor('current needle')
    const target = new CodeMirrorFindTarget([
      { view: base, side: 'base' },
      { view: current, side: 'current' },
    ])

    expect(target.update({ text: 'needle', caseSensitive: false }, 0)).toEqual({
      current: 1,
      total: 3,
      side: 'base',
    })
    expect(base.state.sliceDoc(...selection(base))).toBe('needle')
    expect(target.update({ text: 'needle', caseSensitive: false }, 2)).toEqual({
      current: 3,
      total: 3,
      side: 'current',
    })
    expect(current.state.sliceDoc(...selection(current))).toBe('needle')
    expect(target.update({ text: 'needle', caseSensitive: false }, -1).current).toBe(3)
    expect(target.update({ text: 'needle', caseSensitive: true }, 0).total).toBe(2)
  })

  it('notifies only subscribed sessions when source content changes', () => {
    const target = new CodeMirrorFindTarget([{ view: editor('source') }])
    const listener = vi.fn()
    const unsubscribe = target.subscribe(listener)
    target.contentChanged()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    target.contentChanged()
    expect(listener).toHaveBeenCalledOnce()
  })
})

function editor(content: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: content, extensions: [viewerSearch] }),
  })
  views.push(view)
  return view
}

function selection(view: EditorView): [number, number] {
  const { from, to } = view.state.selection.main
  return [from, to]
}
