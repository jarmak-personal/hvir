import { describe, expect, it, vi } from 'vitest'

import {
  SessionsProjectionCoordinator,
  joinSessionsProjection,
  type SessionsMainObservationPort,
} from '../src/renderer/src/sessions/sessions-projection-coordinator'
import type { SessionsRendererSession } from '../src/renderer/src/sessions/sessions-renderer-observation'
import {
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  type SessionsObservationSnapshot,
  type SessionsProjectionChange,
} from '../src/shared'

const providerId = asHarnessProviderId('codex')
const profileId = asHarnessProfileId('codex-default')

describe('SessionsProjectionCoordinator', () => {
  it('joins lifecycle, connection, attention, Working, and telemetry as independent axes', () => {
    const snapshot = observation(1, [
      observed('live', 'workspace-a', 'live'),
      observed('retained', 'workspace-b', 'retained'),
    ])
    const rows = joinSessionsProjection(snapshot, [
      renderer('live', 'workspace-a', { attention: 'working' }),
      renderer('starting', 'workspace-a', { resumeOnStart: true, attention: 'idle' }),
      renderer('renderer-only', 'workspace-a', { attention: 'bell' }),
    ])

    expect(rows).toHaveLength(4)
    expect(rows.find((row) => row.handle === 'live')).toMatchObject({
      lifecycle: 'live',
      connectionState: 'connected',
      attention: { status: 'available', value: 'none' },
      working: { status: 'available', value: true },
      livePty: { handle: 'pty-live', rendererGeneration: 3 },
      usage: { status: 'unsupported' },
    })
    expect(rows.find((row) => row.handle === 'retained')).toMatchObject({
      lifecycle: 'retained',
      attention: { status: 'unavailable', reason: 'not-materialized' },
      working: { status: 'unavailable', reason: 'not-materialized' },
    })
    expect(rows.find((row) => row.handle === 'starting')).toMatchObject({
      lifecycle: 'resuming',
      attention: { status: 'available', value: 'ready' },
      working: { status: 'available', value: false },
    })
    expect(rows.find((row) => row.handle === 'renderer-only')).toMatchObject({
      lifecycle: 'starting',
      attention: { status: 'available', value: 'bell' },
    })
  })

  it('deduplicates a transient renderer collision in favor of the authoritative workspace', () => {
    const rows = joinSessionsProjection(
      observation(1, [observed('same', 'workspace-b')]),
      [
        renderer('same', 'workspace-a', { title: 'stale move source' }),
        renderer('same', 'workspace-b', { title: 'current move target' }),
      ],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspace: { id: 'workspace-b' },
      title: 'current move target',
    })
  })

  it('ignores a renderer fact qualified to a different workspace', () => {
    const rows = joinSessionsProjection(
      observation(1, [observed('moved', 'workspace-b')]),
      [renderer('moved', 'workspace-a', { title: 'stale source', attention: 'bell' })],
    )

    expect(rows[0]).toMatchObject({
      workspace: { id: 'workspace-b' },
      title: 'Session moved',
      attention: { status: 'unavailable', reason: 'not-materialized' },
    })
  })

  it('shares one main demand, refreshes full snapshots, and releases on the last consumer', async () => {
    const main = mainPort(observation(1, [observed('retained', 'workspace-a')]))
    const rendererSource = rendererPort([])
    const coordinator = new SessionsProjectionCoordinator(main, rendererSource)
    const changed = vi.fn()
    coordinator.subscribe(changed)

    const releaseFirst = coordinator.acquire()
    const releaseSecond = coordinator.acquire()
    await settle()

    expect(main.observe).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().rows).toHaveLength(1)
    const firstRevision = coordinator.snapshot().revision

    rendererSource.set([renderer('retained', 'workspace-a', { attention: 'working' })])
    expect(coordinator.snapshot()).toMatchObject({
      revision: firstRevision + 1,
      rows: [{ working: { status: 'available', value: true } }],
    })

    main.nextSnapshot = observation(2, [
      observed('retained', 'workspace-a'),
      observed('new-session', 'workspace-b'),
    ])
    main.publish({ demandGeneration: 1, revision: 2 })
    await settle()
    expect(main.snapshot).toHaveBeenCalledWith(1)
    expect(coordinator.snapshot().rows).toHaveLength(2)

    releaseFirst()
    expect(main.release).not.toHaveBeenCalled()
    releaseSecond()
    expect(main.release).toHaveBeenCalledExactlyOnceWith(1)
    expect(coordinator.snapshot()).toEqual({
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration: 0,
      revision: 0,
      rows: [],
    })
    expect(rendererSource.listenerCount()).toBe(0)
    expect(main.listenerCount()).toBe(0)
    coordinator.dispose()
  })

  it('rejects a late snapshot after demand is revoked', async () => {
    let resolveRefresh: ((snapshot: SessionsObservationSnapshot) => void) | undefined
    const main = mainPort(observation(1, [observed('first', 'workspace-a')]))
    main.snapshot.mockImplementation(
      () =>
        new Promise<SessionsObservationSnapshot>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const coordinator = new SessionsProjectionCoordinator(main, rendererPort([]))
    const release = coordinator.acquire()
    await settle()

    main.publish({ demandGeneration: 1, revision: 2 })
    await settle()
    release()
    resolveRefresh?.(observation(2, [observed('late', 'workspace-a')]))
    await settle()

    expect(coordinator.snapshot().demandGeneration).toBe(0)
    expect(coordinator.snapshot().rows).toEqual([])
  })
})

function observation(
  revision: number,
  sessions: SessionsObservationSnapshot['sessions'],
): SessionsObservationSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: 1,
    revision,
    providers: [{ id: providerId, displayName: 'Codex', telemetrySupported: true }],
    workspaces: [
      workspace('workspace-a', 'Project A', 'main', 'connected'),
      workspace('workspace-b', 'Project B', 'feature', 'disconnected'),
    ],
    sessions,
  }
}

function workspace(
  workspaceId: string,
  projectName: string,
  workspaceName: string,
  connectionState: 'connected' | 'disconnected',
) {
  return {
    projectId: `project-${workspaceId}`,
    projectName,
    workspaceId,
    workspaceName,
    main: workspaceName === 'main',
    closed: false,
    missing: false,
    host: {
      id: connectionState === 'connected' ? 'local' : 'ssh-test',
      label: connectionState === 'connected' ? 'Local' : 'SSH',
      kind: connectionState === 'connected' ? ('local' as const) : ('ssh' as const),
      connectionState,
    },
  }
}

function observed(
  id: string,
  workspaceId: string,
  lifecycle: 'retained' | 'live' = 'retained',
): SessionsObservationSnapshot['sessions'][number] {
  const unsupported = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle(id),
    workspaceId,
    providerId,
    profile: { status: 'available', value: { id: profileId } },
    title: `Session ${id}`,
    lifecycle,
    livePty:
      lifecycle === 'live'
        ? {
            handle: asSessionsPtyHandle(`pty-${id}`),
            rendererOwnerId: 8,
            rendererGeneration: 3,
          }
        : undefined,
    telemetry: {
      model: unsupported,
      context: unsupported,
      turn: unsupported,
      freshness: unsupported,
    },
  }
}

function renderer(
  id: string,
  workspaceId: string,
  overrides: Partial<SessionsRendererSession> = {},
): SessionsRendererSession {
  return {
    handle: asSessionsTerminalHandle(id),
    workspaceId,
    providerId,
    profileId,
    title: `Renderer ${id}`,
    dormant: false,
    resumeOnStart: false,
    exited: false,
    recoveryUnavailable: false,
    ...overrides,
  }
}

function mainPort(initial: SessionsObservationSnapshot) {
  const listeners = new Set<(change: SessionsProjectionChange) => void>()
  let currentSnapshot = initial
  const port = {
    get nextSnapshot() {
      return currentSnapshot
    },
    set nextSnapshot(value: SessionsObservationSnapshot) {
      currentSnapshot = value
    },
    observe: vi.fn(() => Promise.resolve(initial)),
    snapshot: vi.fn(() => Promise.resolve(currentSnapshot)),
    release: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((listener: (change: SessionsProjectionChange) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    publish: (change: SessionsProjectionChange) => {
      for (const listener of listeners) listener(change)
    },
    listenerCount: () => listeners.size,
  } satisfies SessionsMainObservationPort & {
    nextSnapshot: SessionsObservationSnapshot
    publish(change: SessionsProjectionChange): void
    listenerCount(): number
  }
  return port
}

function rendererPort(initial: readonly SessionsRendererSession[]) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next: readonly SessionsRendererSession[]) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
