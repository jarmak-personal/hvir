import { describe, expect, it, vi } from 'vitest'

import { SessionsUsageCoordinator } from '../src/renderer/src/sessions/sessions-usage-coordinator'
import {
  MAX_SESSIONS_USAGE_ROWS,
  SESSIONS_PROJECTION_VERSION,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
  type SessionsUsageChange,
  type SessionsUsageDemandRequest,
  type SessionsUsageSnapshot,
} from '../src/shared'

describe('SessionsUsageCoordinator', () => {
  it('samples on a bounded cadence, coalesces event refreshes, and rejects late work after release', async () => {
    const clock = new TestClock()
    const main = new TestMain(usageSnapshot(1, 0, 10))
    const coordinator = new SessionsUsageCoordinator(main, clock)
    const projected = projection()
    coordinator.configure(projected.rows, 'session-total', 60_000)
    const release = coordinator.acquire(projected)
    await settle()

    expect(main.observe).toHaveBeenCalledOnce()
    const observed = main.observe.mock.calls[0]?.[0]
    expect(observed?.demandGeneration).toBe(1)
    expect(observed?.projectionDemandGeneration).toBe(4)
    expect(observed?.sourceRevision).toBe(8)
    expect(observed?.targets).toHaveLength(1)
    expect(observed?.targets[0]?.handle).toBe('terminal')
    expect(observed?.targets[0]?.livePty?.handle).toBe('instance')
    expect(coordinator.snapshot().ranking[0]?.rankValue).toBe(10)
    expect(clock.size).toBe(1)

    main.current = usageSnapshot(1, 5_000, 20, 2)
    main.emit({ demandGeneration: 1, revision: 2 })
    await settle()
    expect(coordinator.snapshot().ranking[0]?.usage).toMatchObject({
      status: 'exact',
      value: { normalizedTokenTotal: 20 },
    })
    expect(coordinator.snapshot().ranking[0]?.recent.lastActivityAt).toBeUndefined()

    clock.nowValue = 10_000
    clock.fire()
    await settle()
    expect(coordinator.snapshot().ranking[0]?.recent.lastActivityAt).toBe(5_000)

    let complete!: (value: SessionsUsageSnapshot) => void
    main.snapshot.mockImplementationOnce(
      () => new Promise<SessionsUsageSnapshot>((resolve) => (complete = resolve)),
    )
    clock.nowValue = 20_000
    clock.fire()
    release()
    complete(usageSnapshot(1, 20_000, 500, 3))
    await settle()

    expect(coordinator.snapshot().status).toBe('inactive')
    expect(clock.size).toBe(0)
    expect(main.release).toHaveBeenCalledExactlyOnceWith(1)
    main.emit({ demandGeneration: 1, revision: 99 })
    expect(coordinator.snapshot().status).toBe('inactive')
  })

  it('represents initial observation failure instead of a valid-looking empty state', async () => {
    const main = new TestMain(usageSnapshot(1, 0, 0))
    main.observe.mockRejectedValueOnce(new Error('observation unavailable'))
    const clock = new TestClock()
    const coordinator = new SessionsUsageCoordinator(main, clock)
    const projected = projection()
    coordinator.configure(projected.rows, 'recent', 60_000)
    const release = coordinator.acquire(projected)
    await settle()

    expect(coordinator.snapshot().status).toBe('unavailable')
    expect(coordinator.snapshot().ranking[0]?.usage.status).toBe('pending')
    expect(clock.size).toBe(1)
    clock.fire()
    await settle()
    expect(main.observe).toHaveBeenCalledTimes(2)
    expect(coordinator.snapshot().status).toBe('available')
    release()
    expect(main.release).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('retains an event-reported reset until the next cadence sample', async () => {
    const clock = new TestClock()
    const main = new TestMain(usageSnapshot(1, 0, 100))
    const coordinator = new SessionsUsageCoordinator(main, clock)
    const projected = projection()
    coordinator.configure(projected.rows, 'recent', 60_000)
    const release = coordinator.acquire(projected)
    await settle()

    main.current = {
      ...usageSnapshot(1, 5_000, 0, 2),
      rows: [
        {
          handle: asSessionsTerminalHandle('terminal'),
          usage: { status: 'reset', reason: 'source-unavailable' },
        },
      ],
    }
    main.emit({ demandGeneration: 1, revision: 2 })
    await settle()

    main.current = usageSnapshot(1, 10_000, 200, 3)
    clock.nowValue = 10_000
    clock.fire()
    await settle()

    expect(coordinator.snapshot().ranking[0]?.recent.coverage).toBe('reset')
    expect(coordinator.snapshot().ranking[0]?.rankValue).toBeUndefined()
    release()
  })

  it('rejects an over-capacity usage payload without retaining samples', async () => {
    const initial = usageSnapshot(1, 0, 0)
    const main = new TestMain({
      ...initial,
      rows: Array.from({ length: MAX_SESSIONS_USAGE_ROWS + 1 }, (_, index) => ({
        ...initial.rows[0]!,
        handle: asSessionsTerminalHandle(`terminal-${index}`),
      })),
    })
    const clock = new TestClock()
    const coordinator = new SessionsUsageCoordinator(main, clock)
    const projected = projection()
    coordinator.configure(projected.rows, 'recent', 60_000)
    const release = coordinator.acquire(projected)
    await settle()

    expect(coordinator.snapshot().status).toBe('unavailable')
    expect(clock.size).toBe(1)
    release()
    expect(clock.size).toBe(0)
  })
})

class TestMain {
  current: SessionsUsageSnapshot
  private listener?: (change: SessionsUsageChange) => void
  readonly observe = vi.fn((_request: SessionsUsageDemandRequest) =>
    Promise.resolve(this.current),
  )
  readonly snapshot = vi.fn((_demandGeneration: number) => Promise.resolve(this.current))
  readonly release = vi.fn((_demandGeneration: number) => Promise.resolve())
  readonly subscribe = vi.fn((listener: (change: SessionsUsageChange) => void) => {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  })

  constructor(initial: SessionsUsageSnapshot) {
    this.current = initial
  }

  emit(change: SessionsUsageChange): void {
    this.listener?.(change)
  }
}

class TestClock {
  nowValue = 0
  private nextId = 0
  private readonly callbacks = new Map<number, () => void>()

  now = (): number => this.nowValue
  setTimeout = (callback: () => void): number => {
    const id = ++this.nextId
    this.callbacks.set(id, callback)
    return id
  }
  clearTimeout = (id: number): void => {
    this.callbacks.delete(id)
  }

  get size(): number {
    return this.callbacks.size
  }

  fire(): void {
    const callback = this.callbacks.entries().next().value
    if (!callback) throw new Error('No timer scheduled')
    this.callbacks.delete(callback[0])
    callback[1]()
  }
}

function projection(): SessionsProjectionSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: 4,
    revision: 6,
    sourceRevision: 8,
    status: 'available',
    rows: [row()],
  }
}

function usageSnapshot(
  demandGeneration: number,
  sampledAt: number,
  total: number,
  revision = 1,
): SessionsUsageSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision,
    sampledAt,
    rows: [
      {
        handle: asSessionsTerminalHandle('terminal'),
        usage: {
          status: 'exact',
          observedAt: sampledAt,
          value: {
            freshInputTokens: total,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            normalizedTokenTotal: total,
          },
        },
      },
    ],
  }
}

function row(): SessionsProjectionRow {
  const unsupported = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle('terminal'),
    project: { id: asSessionsProjectHandle('project'), name: 'Project' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace'),
      name: 'main',
      main: true,
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId('future-provider'),
      name: 'Future provider',
      kind: 'agent',
    },
    profile: unsupported,
    title: 'Terminal',
    lifecycle: 'live',
    connectionState: 'connected',
    attention: unsupported,
    working: unsupported,
    model: unsupported,
    context: unsupported,
    turn: unsupported,
    telemetryFreshness: unsupported,
    usage: { status: 'pending', reason: 'identity-pending' },
    livePty: {
      handle: asSessionsPtyHandle('instance'),
      rendererOwnerId: 1,
      rendererGeneration: 2,
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
