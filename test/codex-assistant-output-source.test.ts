import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { CodexAssistantOutputSource } from '../src/main/harness/codex-assistant-output-source'
import { LOCAL_HOST_ID, type AssistantOutputEvent } from '../src/shared'

function frame(
  order: number,
  kind: 'start' | 'delta' | 'end' | 'abort',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    revision: 1,
    sourceId: `source-${order}`,
    order,
    kind,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'message-1',
    ...extra,
  })
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function fixture() {
  const events: AssistantOutputEvent[] = []
  const revoke = vi.fn()
  const source = new CodexAssistantOutputSource({
    hostId: LOCAL_HOST_ID,
    generation: 7,
    emit: (event) => events.push(event),
    revoke,
  })
  return { source, events, revoke }
}

describe('CodexAssistantOutputSource', () => {
  it('emits one exact admitted agent-message lifecycle in source order', () => {
    const { source, events, revoke } = fixture()
    expect(source.admitSession('thread-1')).toBe(true)

    source.accept(frame(1, 'start'))
    source.accept(frame(2, 'delta', { text: 'hello ' }))
    source.accept(frame(3, 'delta', { text: 'world' }))
    source.accept(
      frame(4, 'end', {
        finalBytes: 11,
        finalDigest: digest('hello world'),
      }),
    )

    expect(events.map((event) => event.kind)).toEqual(['start', 'delta', 'delta', 'end'])
    expect(events[1]).toMatchObject({
      hostId: LOCAL_HOST_ID,
      providerId: 'codex',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      order: 2,
      generation: 7,
      text: 'hello ',
    })
    expect(revoke).not.toHaveBeenCalled()
  })

  it('treats an exact repeated source identity and payload as idempotent', () => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    const start = frame(1, 'start')
    source.accept(start)
    source.accept(start)
    source.accept(frame(2, 'delta', { text: 'same' }))
    source.accept(frame(3, 'end', { finalBytes: 4, finalDigest: digest('same') }))

    expect(events.map((event) => event.kind)).toEqual(['start', 'delta', 'end'])
    expect(revoke).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong session', frame(1, 'start', { threadId: 'thread-2' })],
    ['order gap', frame(2, 'start')],
    ['malformed', '{'],
    ['unsupported revision', frame(1, 'start', { revision: 2 })],
    ['oversized record', 'x'.repeat(64 * 1024 + 1)],
    ['overlong identifier', frame(1, 'start', { itemId: 'x'.repeat(161) })],
    ['non-ASCII identifier', frame(1, 'start', { turnId: 'turn-λ' })],
  ])('fails closed for a %s record', (_label, record) => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(record)

    expect(events).toEqual([])
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('aborts a safe prefix when an identity is revised', () => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    source.accept(frame(2, 'delta', { text: 'safe' }))
    source.accept(frame(2, 'delta', { text: 'revised' }))

    expect(events.map((event) => event.kind)).toEqual(['start', 'delta', 'abort'])
    expect(events.at(-1)).toMatchObject({
      kind: 'abort',
      reason: 'source-invalid',
      order: 3,
    })
    expect(revoke).toHaveBeenCalledOnce()
  })

  it.each([
    ['mismatched completion text', { finalBytes: 5, finalDigest: digest('other') }],
    ['revised completion length', { finalBytes: 4, finalDigest: digest('hello') }],
  ])('fails closed for %s', (_label, completion) => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    source.accept(frame(2, 'delta', { text: 'hello' }))
    source.accept(frame(3, 'end', completion))

    expect(events.map((event) => event.kind)).toEqual(['start', 'delta', 'abort'])
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('rejects a second concurrent message and all later records', () => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    source.accept(frame(2, 'start', { itemId: 'message-2' }))
    source.accept(frame(3, 'delta', { text: 'late' }))

    expect(events.map((event) => event.kind)).toEqual(['start', 'abort'])
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('preserves an interrupted turn as an explicit abort outcome', () => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    source.accept(frame(2, 'abort', { reason: 'turn-interrupted' }))
    source.accept(
      frame(3, 'start', {
        turnId: 'turn-2',
        itemId: 'message-2',
      }),
    )

    expect(events.map((event) => event.kind)).toEqual(['start', 'abort', 'start'])
    expect(events[1]).toMatchObject({ order: 2, reason: 'turn-interrupted' })
    expect(events.at(-1)).toMatchObject({ order: 3, turnId: 'turn-2' })
    expect(revoke).not.toHaveBeenCalled()
  })

  it('bounds one retained message body', () => {
    const { source, events, revoke } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    const chunk = 'x'.repeat(32 * 1024)
    for (let order = 2; order <= 33; order++) {
      source.accept(frame(order, 'delta', { text: chunk }))
    }
    source.accept(frame(34, 'delta', { text: 'overflow' }))

    expect(events.at(-1)).toMatchObject({ kind: 'abort', reason: 'source-invalid' })
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('rejects late records after source disposal', () => {
    const { source, events } = fixture()
    source.admitSession('thread-1')
    source.accept(frame(1, 'start'))
    source.dispose('renderer-revoked')
    source.accept(frame(2, 'delta', { text: 'late' }))

    expect(events.map((event) => event.kind)).toEqual(['start', 'abort'])
    expect(events.at(-1)).toMatchObject({ reason: 'renderer-revoked' })
  })
})
