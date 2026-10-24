import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  JsonWorkerRequestInput,
  JsonWorkerResponse,
} from '../src/renderer/src/viewer/json-protocol'

let receive: (event: { data: JsonWorkerRequestInput & { requestId: number } }) => void
let response: JsonWorkerResponse
let requestId = 0

beforeEach(async () => {
  vi.resetModules()
  const scope = {
    onmessage: undefined,
    postMessage: (value: JsonWorkerResponse) => {
      response = value
    },
  }
  vi.stubGlobal('self', scope)
  await import('../src/renderer/src/viewer/json.worker')
  receive = scope.onmessage!
})
afterEach(() => vi.unstubAllGlobals())

function request(input: JsonWorkerRequestInput): JsonWorkerResponse {
  receive({ data: { ...input, requestId: ++requestId } })
  return response
}

describe('JSONL worker protocol', () => {
  it('returns bounded record pages, line errors and lazy nested values', () => {
    const source = [
      '{"nested":[{"ok":true}]}',
      'broken',
      ...Array.from({ length: 1000 }, (_, index) => String(index)),
    ].join('\n')
    expect(
      request({ type: 'parse', documentId: 1, source, format: 'jsonl' }),
    ).toMatchObject({ type: 'parsed', root: { kind: 'array', count: 1002 } })
    const page = request({
      type: 'children',
      documentId: 1,
      path: [],
      offset: 0,
      limit: 100,
    })
    expect(page.type).toBe('children')
    if (page.type !== 'children') return
    expect(page.children).toHaveLength(100)
    expect(page.children[0]).toMatchObject({
      label: 'Line 1',
      path: ['0'],
      kind: 'object',
      sourceLine: 1,
      count: 1,
    })
    expect(page.children[1]).toMatchObject({
      sourceLine: 2,
      error: 'Invalid JSON record',
    })
    expect(page.children[99]).toMatchObject({ sourceLine: 100, value: 97 })
    expect(
      request({ type: 'children', documentId: 1, path: ['0'], offset: 0, limit: 100 }),
    ).toMatchObject({
      type: 'children',
      children: [{ label: 'nested', path: ['0', 'nested'], kind: 'array', count: 1 }],
    })
    expect(
      request({
        type: 'children',
        documentId: 1,
        path: ['0', 'nested', '0'],
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({
      type: 'children',
      children: [{ label: 'ok', kind: 'boolean', value: true }],
    })
    expect(
      request({ type: 'children', documentId: 1, path: [], offset: 1000, limit: 100 }),
    ).toMatchObject({
      type: 'children',
      children: [
        { sourceLine: 1001, value: 998 },
        { sourceLine: 1002, value: 999 },
      ],
    })
    request({ type: 'dispose', documentId: 1 })
    expect(
      request({ type: 'children', documentId: 1, path: [], offset: 0, limit: 100 }),
    ).toMatchObject({ type: 'error', message: 'JSON document expired' })
  })

  it('bounds JSONL scalar previews at any depth and leaves ordinary JSON intact', () => {
    const value = 'x'.repeat(100_000)
    request({
      type: 'parse',
      documentId: 1,
      source: JSON.stringify(value),
      format: 'jsonl',
    })
    const page = request({
      type: 'children',
      documentId: 1,
      path: [],
      offset: 0,
      limit: 100,
    })
    expect(page).toMatchObject({
      type: 'children',
      children: [{ value: value.slice(0, 4096), truncated: true }],
    })
    request({
      type: 'parse',
      documentId: 2,
      source: JSON.stringify({ value }),
      format: 'jsonl',
    })
    expect(
      request({ type: 'children', documentId: 2, path: ['0'], offset: 0, limit: 100 }),
    ).toMatchObject({
      type: 'children',
      children: [{ value: value.slice(0, 4096), truncated: true }],
    })
    expect(
      request({
        type: 'parse',
        documentId: 3,
        source: JSON.stringify(value),
        format: 'json',
      }),
    ).toMatchObject({ type: 'parsed', root: { value } })
  })
})
