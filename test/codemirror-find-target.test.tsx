// @vitest-environment happy-dom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodeMirrorFindTarget,
  viewerFindDecorations,
} from '../src/renderer/src/viewer/codemirror-find-target'
import { createFindWorker } from '../src/renderer/src/viewer/find-worker'
import { ViewerFindWorker as WorkerBoundary } from './fixtures/viewer-find-worker'
import { FIND_MATCH_PAGE_SIZE } from '../src/renderer/src/viewer/find-match-index'

vi.mock('../src/renderer/src/viewer/find-worker', () => ({ createFindWorker: vi.fn() }))
const views: EditorView[] = []
let workers: WorkerBoundary[]
beforeEach(() => {
  vi.useFakeTimers()
  workers = []
  vi.mocked(createFindWorker).mockImplementation(() => {
    const worker = new WorkerBoundary()
    workers.push(worker)
    return worker as unknown as Worker
  })
})
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  vi.useRealTimers()
})
const query = { text: 'needle', caseSensitive: false }
function complete(worker: WorkerBoundary, document: number, ranges: number[]): void {
  if (ranges.length)
    worker.respond({ type: 'matches', document, ranges: new Uint32Array(ranges) })
  worker.respond({ type: 'done', document })
}

describe('CodeMirrorFindTarget at its worker boundary', () => {
  it('completes small searches immediately without worker startup or pending state', () => {
    const base = editor('CAFÉ cafe\u0301')
    const current = editor('café')
    const target = new CodeMirrorFindTarget([
      { view: base, side: 'base' },
      { view: current, side: 'current' },
    ])
    const query = { text: 'café', caseSensitive: false }
    expect(target.update(query, 0)).toEqual({ current: 1, total: 3, side: 'base' })
    expect(target.update(query, -1)).toEqual({ current: 3, total: 3, side: 'current' })
    expect(target.update({ ...query, caseSensitive: true }, 0)).toEqual({
      current: 1,
      total: 2,
      side: 'base',
    })
    expect(createFindWorker).not.toHaveBeenCalled()
    target.clear()
  })

  it('publishes complete counts across both sides and caches results through wrapping and navigation', async () => {
    const base = editor('needle base NEEDLE' + ' '.repeat(2049))
    const current = editor('current needle')
    const target = new CodeMirrorFindTarget([
      { view: base, side: 'base' },
      { view: current, side: 'current' },
    ])
    const changed = vi.fn()
    target.subscribe(changed)
    expect(target.update(query, 0)).toEqual({ current: 0, total: 0, pending: true })
    await vi.runAllTimersAsync()
    complete(workers[0]!, 0, [0, 6, 12, 18])
    expect(changed).not.toHaveBeenCalled()
    expect(target.update(query, 0).pending).toBe(true)
    complete(workers[0]!, 1, [8, 14])
    expect(changed).toHaveBeenCalledOnce()
    expect(target.update(query, 0)).toEqual({ current: 1, total: 3, side: 'base' })
    expect(base.state.sliceDoc(...selection(base))).toBe('needle')
    expect(base.dom.querySelectorAll('.cm-hvir-find-match')).toHaveLength(2)
    expect(target.update(query, 2)).toEqual({ current: 3, total: 3, side: 'current' })
    expect(current.state.sliceDoc(...selection(current))).toBe('needle')
    expect(target.update(query, -1).current).toBe(3)
    expect(createFindWorker).toHaveBeenCalledOnce()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(target.update({ ...query, caseSensitive: true }, 0).pending).toBe(true)
    expect(createFindWorker).toHaveBeenCalledTimes(2)
    target.clear()
  })

  it('bounds snapshot transfers and visible decorations for dense results', async () => {
    const view = editor('x\n'.repeat(100_000))
    const target = new CodeMirrorFindTarget([{ view }])
    const denseQuery = { text: 'x', caseSensitive: false }
    target.update(denseQuery, 0)
    await vi.runAllTimersAsync()
    const chunks = workers[0]!.postMessage.mock.calls
      .map(([data]) => data)
      .filter((data) => data.type === 'chunk')
    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map((data) => data.content.length))).toBeLessThanOrEqual(
      32768,
    )
    expect(chunks.map((data) => data.content).join('')).toBe(view.state.doc.toString())
    for (let from = 0; from < 100_000; from += FIND_MATCH_PAGE_SIZE) {
      const length = Math.min(FIND_MATCH_PAGE_SIZE, 100_000 - from)
      workers[0]!.respond({
        type: 'matches',
        document: 0,
        ranges: Uint32Array.from(
          { length: length * 2 },
          (_, i) => (from + Math.floor(i / 2)) * 2 + (i % 2),
        ),
      })
    }
    workers[0]!.respond({ type: 'done', document: 0 })
    expect(target.update(denseQuery, 99_999)).toEqual({
      current: 100_000,
      total: 100_000,
    })
    expect(selection(view)).toEqual([199_998, 199_999])
    expect(view.dom.querySelectorAll('.cm-hvir-find-match').length).toBeLessThan(2002)
    target.clear()
  })

  it('eventually decorates every visible dense match across bounded turns', async () => {
    const count = 6000
    const view = editor('x'.repeat(count))
    const target = new CodeMirrorFindTarget([{ view }])
    const query = { text: 'x', caseSensitive: true }
    target.update(query, 0)
    await vi.runAllTimersAsync()
    for (let from = 0; from < count; from += FIND_MATCH_PAGE_SIZE) {
      const length = Math.min(FIND_MATCH_PAGE_SIZE, count - from)
      workers[0]!.respond({
        type: 'matches',
        document: 0,
        ranges: Uint32Array.from(
          { length: length * 2 },
          (_, i) => from + Math.floor(i / 2) + (i % 2),
        ),
      })
    }
    workers[0]!.respond({ type: 'done', document: 0 })
    target.update(query, 0)
    const decoratedLength = () =>
      [...view.dom.querySelectorAll('.cm-hvir-find-match')].reduce(
        (sum, node) => sum + (node.textContent?.length ?? 0),
        0,
      )
    expect(decoratedLength()).toBeLessThan(count)
    await vi.runAllTimersAsync()
    const visibleLength = view.visibleRanges.reduce(
      (sum, range) => sum + range.to - range.from,
      0,
    )
    expect(visibleLength).toBeGreaterThan(2000)
    expect(decoratedLength()).toBe(visibleLength)
    target.update(query, 1)
    expect(decoratedLength()).toBe(visibleLength)
    target.clear()
    await vi.runAllTimersAsync()
    expect(decoratedLength()).toBe(0)
  })

  it('revokes superseded queries, document generations, and closed sessions including queued callbacks', async () => {
    const view = editor('needle' + ' '.repeat(2049))
    const target = new CodeMirrorFindTarget([{ view }])
    target.update(query, 0)
    const stale = workers[0]!
    target.update({ text: 'other', caseSensitive: false }, 0)
    expect(stale.terminate).toHaveBeenCalledOnce()
    complete(stale, 0, [0, 6])
    expect(target.update({ text: 'other', caseSensitive: false }, 0).pending).toBe(true)
    const changed = vi.fn()
    const unsubscribe = target.subscribe(changed)
    view.dispatch({ changes: { from: 0, to: 6, insert: 'unsaved needle' } })
    target.contentChanged()
    expect(workers[1]!.terminate).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
    target.update(query, 0)
    await vi.runAllTimersAsync()
    expect(workers[2]!.postMessage).toHaveBeenCalledWith({
      type: 'chunk',
      content: 'unsaved needle' + ' '.repeat(2049),
    })
    const pending = workers[2]!
    target.clear()
    complete(pending, 0, [8, 14])
    expect(changed).toHaveBeenCalledOnce()
    expect(view.dom.querySelector('.cm-hvir-find-match')).toBeNull()
    unsubscribe()
  })

  it('reveals diff content once and exposes worker failure without a false complete zero', () => {
    const revealMatches = vi.fn()
    const target = new CodeMirrorFindTarget(
      [{ view: editor('needle' + ' '.repeat(2049)) }],
      {
        revealMatches,
      },
    )
    target.update(query, 0)
    workers[0]!.onerror?.()
    expect(target.update(query, 0)).toEqual({ current: 0, total: 0, error: true })
    target.update({ text: 'other', caseSensitive: false }, 0)
    expect(revealMatches).toHaveBeenCalledOnce()
    target.clear()
  })
})
function editor(content: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: content, extensions: [viewerFindDecorations] }),
  })
  views.push(view)
  return view
}
function selection(view: EditorView): [number, number] {
  const { from, to } = view.state.selection.main
  return [from, to]
}
