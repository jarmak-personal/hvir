import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FindWorkerRequest,
  FindWorkerResponse,
} from '../src/renderer/src/viewer/find-worker-protocol'
import {
  FindMatchIndex,
  FIND_MATCH_PAGE_SIZE,
} from '../src/renderer/src/viewer/find-match-index'

const worker = {
  onmessage: undefined as undefined | ((event: { data: FindWorkerRequest }) => void),
  postMessage: vi.fn<(response: FindWorkerResponse, options?: unknown) => void>(),
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  worker.postMessage.mockClear()
})
async function start(): Promise<void> {
  vi.stubGlobal('self', worker)
  await import('../src/renderer/src/viewer/find.worker')
}
function send(data: FindWorkerRequest): void {
  worker.onmessage!({ data })
}
function pages(): Uint32Array[] {
  return worker.postMessage.mock.calls
    .map(([data]) => data)
    .filter((data) => data.type === 'matches')
    .map((data) => data.ranges)
}

describe('find worker and compact match index', () => {
  it('preserves CodeMirror Unicode/case and multiline semantics across snapshot chunks', async () => {
    await start()
    send({ type: 'chunk', content: 'CAFÉ\ncaf' })
    send({ type: 'chunk', content: 'e\u0301\nCafé' })
    send({ type: 'search', document: 0, query: { text: 'café', caseSensitive: false } })
    expect([...pages()[0]!]).toEqual([0, 4, 5, 10, 11, 15])
    worker.postMessage.mockClear()
    send({ type: 'chunk', content: 'one\ntwo\none\nTWO' })
    send({
      type: 'search',
      document: 1,
      query: { text: 'one\ntwo', caseSensitive: true },
    })
    expect([...pages()[0]!]).toEqual([0, 7])
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      { type: 'done', document: 1 },
      { transfer: [] },
    )
  })

  it('streams bounded pages and indexes navigation and viewport boundaries without flattening results', async () => {
    await start()
    const count = FIND_MATCH_PAGE_SIZE * 2 + 17
    send({ type: 'chunk', content: 'x\n'.repeat(count) })
    send({ type: 'search', document: 0, query: { text: 'x', caseSensitive: false } })
    const index = new FindMatchIndex()
    for (const page of pages()) {
      expect(page.length).toBeLessThanOrEqual(FIND_MATCH_PAGE_SIZE * 2)
      index.append(page)
    }
    expect(pages()).toHaveLength(3)
    expect(index.length).toBe(count)
    expect(index.at(FIND_MATCH_PAGE_SIZE)).toEqual({
      from: FIND_MATCH_PAGE_SIZE * 2,
      to: FIND_MATCH_PAGE_SIZE * 2 + 1,
    })
    expect(index.at(count - 1)).toEqual({
      from: (count - 1) * 2,
      to: (count - 1) * 2 + 1,
    })
    expect(index.firstEndingAfter(0)).toBe(0)
    expect(index.firstEndingAfter(1)).toBe(1)
    expect(index.firstEndingAfter(count * 2)).toBe(count)
  })
})
