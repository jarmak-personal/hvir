import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PtyStreamHandlers } from '../src/main/pty/pty-supervisor'
import {
  startCapacityOutputFixtures,
  type CapacityOutputFixtureSupervisor,
} from '../src/main/smoke/capacity-output-fixtures'
import type { Disposer } from '../src/shared'

describe('capacity output fixture lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes before interruption and waits for every split shutdown marker', async () => {
    const supervisor = new FakeCapacitySupervisor()
    const fixtures = startCapacityOutputFixtures(supervisor)

    expect(supervisor.producerMarkers).toHaveLength(12)
    expect(new Set(supervisor.producerMarkers).size).toBe(12)

    let settled = false
    const stopped = fixtures.stop().finally(() => {
      settled = true
    })

    expect(supervisor.subscriptionsAtFirstInterrupt).toBe(12)
    expect(supervisor.interrupts).toBe(12)
    for (let index = 0; index < 11; index += 1) supervisor.acknowledge(index, true)
    await Promise.resolve()
    expect(settled).toBe(false)

    supervisor.acknowledge(11, true)
    await stopped
    expect(supervisor.disposals).toBe(12)

    await fixtures.stop()
    expect(supervisor.interrupts).toBe(12)
    expect(supervisor.attachments).toBe(12)
  })

  it('times out with count-only state and releases every subscription', async () => {
    vi.useFakeTimers()
    const supervisor = new FakeCapacitySupervisor()
    const fixtures = startCapacityOutputFixtures(supervisor)
    const stopped = fixtures.stop()
    for (let index = 0; index < 4; index += 1) supervisor.acknowledge(index, false)

    const rejection = expect(stopped).rejects.toThrow(
      'capacity output producers did not acknowledge shutdown ' +
        '(acknowledged=4/12, dataCallbacks=4, exited=0, interrupts=12/12)',
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(supervisor.disposals).toBe(12)
  })

  it('cleans partial subscriptions when attachment fails before interruption', async () => {
    const supervisor = new FakeCapacitySupervisor()
    supervisor.failAttachmentAt = 5
    const fixtures = startCapacityOutputFixtures(supervisor)

    await expect(fixtures.stop()).rejects.toThrow('capacity fixture attachment failed')
    expect(supervisor.attachments).toBe(5)
    expect(supervisor.disposals).toBe(5)
    expect(supervisor.interrupts).toBe(0)
  })

  it('releases every subscription when a producer exits during partial shutdown', async () => {
    const supervisor = new FakeCapacitySupervisor()
    const fixtures = startCapacityOutputFixtures(supervisor)
    const stopped = fixtures.stop()
    for (let index = 0; index < 3; index += 1) supervisor.acknowledge(index, false)
    supervisor.exit(3)

    await expect(stopped).rejects.toThrow(
      'capacity output producer exited before shutdown acknowledgement ' +
        '(acknowledged=3/12, dataCallbacks=3, exited=1, interrupts=12/12)',
    )
    expect(supervisor.disposals).toBe(12)
  })
})

interface FakeTerminal {
  readonly id: string
  readonly ownerId: number
  readonly ownerGeneration: number
}

class FakeCapacitySupervisor implements CapacityOutputFixtureSupervisor {
  readonly terminals: readonly FakeTerminal[] = Array.from(
    { length: 12 },
    (_, index) => ({
      id: `terminal-${index}`,
      ownerId: 7,
      ownerGeneration: 3,
    }),
  )
  readonly producerMarkers: string[] = []
  readonly handlers = new Map<string, PtyStreamHandlers>()
  attachments = 0
  disposals = 0
  interrupts = 0
  subscriptionsAtFirstInterrupt = 0
  failAttachmentAt: number | undefined

  list(): readonly FakeTerminal[] {
    return this.terminals
  }

  attach(
    id: string,
    _ownerId: number,
    handlers: PtyStreamHandlers,
    _ownerGeneration?: number,
  ): Disposer {
    if (this.failAttachmentAt === this.attachments) {
      throw new Error('capacity fixture attachment failed')
    }
    this.attachments++
    this.handlers.set(id, handlers)
    return () => {
      this.disposals++
      this.handlers.delete(id)
    }
  }

  write(_id: string, _ownerId: number, data: string, _ownerGeneration?: number): void {
    const marker = data.match(/__HVIR_CAPACITY_OUTPUT_STOPPED_\d{2}__/)?.[0]
    if (marker) this.producerMarkers.push(marker)
    if (data !== '\u0003') return
    if (this.interrupts === 0) this.subscriptionsAtFirstInterrupt = this.handlers.size
    this.interrupts++
  }

  acknowledge(index: number, split: boolean): void {
    const marker = this.producerMarkers[index]!
    const handler = this.handlers.get(`terminal-${index}`)?.onData
    if (!handler) throw new Error(`terminal ${index} has no data handler`)
    if (!split) {
      handler(marker)
      return
    }
    const boundary = Math.floor(marker.length / 2)
    handler(`unrelated-${marker.slice(0, boundary)}`)
    handler(`${marker.slice(boundary)}-unrelated`)
  }

  exit(index: number): void {
    this.handlers.get(`terminal-${index}`)?.onExit?.({ exitCode: 1, signal: undefined })
  }
}
