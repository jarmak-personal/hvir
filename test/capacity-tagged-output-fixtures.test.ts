import { expect, it } from 'vitest'
import {
  startCapacityOutputFixtures,
  type CapacityOutputFixtureSupervisor,
} from '../src/main/smoke/capacity-output-fixtures'
import type { PtyStreamHandlers } from '../src/main/pty/pty-supervisor'

it('leaves the tagged first actor untouched and shuts down the eleven original producer roles', async () => {
  const terminals = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    ownerId: 7,
    ownerGeneration: 3,
  }))
  const writes = new Map<string, string[]>()
  const handlers = new Map<string, PtyStreamHandlers>()
  let disposed = 0
  const supervisor: CapacityOutputFixtureSupervisor = {
    list: () => terminals,
    attach: (id, _owner, handler) => {
      handlers.set(id, handler)
      return () => {
        handlers.delete(id)
        disposed++
      }
    },
    write: (id, _owner, data) => {
      const previous = writes.get(id) ?? []
      writes.set(id, [...previous, data])
      if (data === '\u0003') {
        expect(handlers.size).toBe(11)
        const marker = previous
          .join('')
          .match(/__HVIR_CAPACITY_OUTPUT_STOPPED_\d{2}__/)?.[0]
        if (!marker) throw new Error('producer has no shutdown marker')
        const listener = handlers.get(id)?.onData
        if (!listener) throw new Error('producer has no output observer')
        listener(marker.slice(0, 8))
        listener(marker.slice(8))
      }
    },
  }
  const fixtures = startCapacityOutputFixtures(supervisor, { taggedTerminalId: '0' })
  expect(writes.has('0')).toBe(false)
  expect(writes.get('1')?.join('')).toContain('plain-hidden-')
  expect(writes.get('2')?.join('')).toContain('Thinking')
  for (let index = 3; index < 12; index++) {
    const source = writes.get(String(index))?.join('')
    expect(source).toContain('2026h')
    expect(source).toContain('sleep 0.2')
    expect(source).toContain(
      '__HVIR_CAPACITY_OUTPUT_STOPPED_' + String(index).padStart(2, '0') + '__',
    )
  }
  await fixtures.stop()
  await fixtures.stop()
  expect(disposed).toBe(11)
  expect(writes.has('0')).toBe(false)
  expect(handlers.size).toBe(0)
})

it('rejects an actor substitution that would change the original capacity roles', () => {
  const terminals = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    ownerId: 7,
    ownerGeneration: 3,
  }))
  expect(() =>
    startCapacityOutputFixtures(
      {
        list: () => terminals,
        attach: () => () => undefined,
        write: () => {
          throw new Error('must validate before writing')
        },
      },
      { taggedTerminalId: '1' },
    ),
  ).toThrow('first terminal')
})
