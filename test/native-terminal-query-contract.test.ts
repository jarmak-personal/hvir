import { describe, expect, it } from 'vitest'
import {
  validNativeTerminalQueryRequest as request,
  validNativeTerminalQueryResponse as response,
  validNativeTerminalQueryUpdate as update,
} from '../src/shared/native-terminal-query'

const viewId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const queryId = '33333333-3333-4333-8333-333333333333'
const boundaryId = '44444444-4444-4444-8444-444444444444'
const owner = { viewId, requestId }

describe('native retained query admission', () => {
  it('requires owner/request qualification and accepts only the operation fields', () => {
    const begin = { ...owner, kind: 'begin', text: 'a.*a', caseSensitive: false }
    expect(request(begin)).toBe(true)
    expect(request({ ...begin, viewId: undefined })).toBe(false)
    expect(request({ ...begin, requestId: '17' })).toBe(false)
    expect(request({ ...begin, nativeState: '12' })).toBe(false)
    expect(request({ ...owner, kind: 'at', queryId, index: 10001 })).toBe(true)
    expect(request({ ...owner, kind: 'at', queryId, index: -1 })).toBe(false)
    expect(request({ ...owner, kind: 'at', queryId, index: 1.5 })).toBe(false)
  })

  it('keeps the existing query-specific UTF-8 bound distinct from productive reads', () => {
    const begin = { ...owner, kind: 'begin', caseSensitive: true }
    expect(request({ ...begin, text: '🙂'.repeat(16384) })).toBe(true)
    expect(request({ ...begin, text: '🙂'.repeat(16385) })).toBe(false)
    expect(request({ ...begin, text: '' })).toBe(false)
    // Transport/read authority has no new total-text ceiling.
    expect(response({ kind: 'text', text: 'x'.repeat(2 * 1024 * 1024) })).toBe(true)
  })

  it('distinguishes Main boundary handles from native occurrence counters', () => {
    expect(
      request({ ...owner, kind: 'read', queryId, occurrenceId: '18446744073709551615' }),
    ).toBe(true)
    expect(
      request({ ...owner, kind: 'read', queryId, occurrenceId: '18446744073709551616' }),
    ).toBe(false)
    expect(request({ ...owner, kind: 'boundary-resolve', boundaryId })).toBe(true)
    expect(request({ ...owner, kind: 'boundary-resolve', boundaryId: '1' })).toBe(false)
    expect(request({ ...owner, kind: 'range-read', startId: boundaryId })).toBe(true)
    expect(
      request({ ...owner, kind: 'range-read', startId: boundaryId, endId: '0' }),
    ).toBe(false)
  })

  it('admits useful partial counts while rejecting malformed progress and authority extras', () => {
    const snapshot = { revision: 3, matchCount: 12000, pending: true, invalidated: false }
    expect(update({ viewId, queryId, snapshot })).toBe(true)
    expect(update({ viewId, queryId, snapshot: { ...snapshot, matchCount: NaN } })).toBe(
      false,
    )
    expect(
      update({ viewId, queryId, snapshot: { ...snapshot, text: 'not metadata' } }),
    ).toBe(false)
    expect(response({ kind: 'resolved', index: 11999 })).toBe(true)
    expect(response({ kind: 'resolved' })).toBe(true)
    expect(request({ ...owner, kind: 'capture-end' })).toBe(false)
    expect(request({ ...owner, kind: 'boundary-close', boundaryId })).toBe(false)
    expect(response({ kind: 'boundary-captured', boundaryId })).toBe(false)
  })
})
