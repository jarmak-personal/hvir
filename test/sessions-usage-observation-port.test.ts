import { describe, expect, it, vi } from 'vitest'

import { SessionsUsageObservationPort } from '../src/main/sessions/sessions-usage-observation-port'
import type { SessionsResolvedUsageTarget } from '../src/main/sessions/sessions-observation-port'
import { usageObservationHarnessTelemetry } from '../src/main/harness/harness-usage'
import type { HarnessUsageDemand } from '../src/main/harness/harness-usage-demand-controller'
import type { PtyUsageObservationResolution } from '../src/main/pty/pty-supervisor'
import {
  asHarnessProviderId,
  asHostId,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  hostPath,
  type SessionsUsageDemandRequest,
} from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'

const owner = { id: 9, generation: 3 }
const providerId = asHarnessProviderId('future-trusted-provider')

describe('SessionsUsageObservationPort', () => {
  it('projects only bounded numeric facts and revokes exact demand when the source changes', async () => {
    const fixture = createFixture()
    const initial = fixture.port.acquire(owner, request(1))

    expect(initial.rows[0]?.usage).toEqual({
      status: 'pending',
      reason: 'observation-pending',
    })
    expect(fixture.acquired).toHaveLength(1)
    fixture.acquired[0]?.emit(
      usageObservationHarnessTelemetry({
        providerId,
        sessionId: 'private-provider-session',
        provenance: 'private artifact path and provider prose',
        counters: {
          freshInputTokens: 10,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 30,
          outputTokens: 40,
          reasoningTokens: 5,
        },
        observedAt: 50,
      })!,
    )
    const projected = fixture.port.snapshot(owner, 1)
    expect(projected.rows[0]?.usage).toEqual({
      status: 'exact',
      observedAt: 50,
      value: {
        freshInputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
        outputTokens: 40,
        reasoningTokens: 5,
        normalizedTokenTotal: 100,
      },
    })
    expect(JSON.stringify(projected)).not.toContain('private-provider-session')
    expect(JSON.stringify(projected)).not.toContain('private artifact')

    fixture.sourceChanged()
    await Promise.resolve()
    expect(fixture.releases[0]).toHaveBeenCalledOnce()
    expect(fixture.port.snapshot(owner, 1).rows[0]?.usage).toEqual({
      status: 'unavailable',
      reason: 'source-unavailable',
    })
    expect(fixture.emit).toHaveBeenCalledWith(owner, {
      demandGeneration: 1,
      revision: 3,
    })

    fixture.acquired[0]?.emit(
      usageObservationHarnessTelemetry({
        providerId,
        sessionId: 'late-private-provider-session',
        provenance: 'late provider observation',
        counters: { freshInputTokens: 500 },
        observedAt: 60,
      })!,
    )
    expect(fixture.port.snapshot(owner, 1).rows[0]?.usage).toEqual({
      status: 'unavailable',
      reason: 'source-unavailable',
    })
  })

  it('uses the exact existing SSH host without connecting or allocating per-row transport', () => {
    const remoteHost = projectHost('ssh:remote')
    const fixture = createFixture(remoteHost)
    fixture.port.acquire(owner, request(2))

    expect(fixture.acquired[0]?.target.host).toBe(remoteHost)
    expect(fixture.resolveUsageObservation).toHaveBeenCalledWith(
      'terminal-1',
      'instance-1',
    )
    expect(fixture.acquired).toHaveLength(1)
    expect(remoteHost.connectionState).toBe('connected')
    expect(fixture.port.release(owner, 2)).toBe(true)
    expect(fixture.releases[0]).toHaveBeenCalledOnce()
    expect(fixture.stopSourceObservation).toHaveBeenCalledOnce()
  })

  it('keeps an unchanged exact target across an unrelated newer source revision', () => {
    const fixture = createFixture()
    fixture.currentUsageTargets.mockImplementation((_owner, _generation, targets) =>
      fixture.resolveTargets(owner, { ...request(1), targets }),
    )
    fixture.port.acquire(owner, request(1))

    fixture.sourceChanged()
    expect(fixture.releases[0]).not.toHaveBeenCalled()
    expect(fixture.port.snapshot(owner, 1).rows[0]?.usage.status).toBe('pending')
    fixture.port.release(owner, 1)
    expect(fixture.releases[0]).toHaveBeenCalledOnce()
  })

  it('starts the shared observer when the same live PTY finishes identity discovery', () => {
    const fixture = createFixture()
    fixture.resolveUsageObservation.mockReturnValueOnce({ status: 'pending' })
    fixture.currentUsageTargets.mockImplementation((_owner, _generation, targets) =>
      fixture.resolveTargets(owner, { ...request(1), targets }),
    )
    const initial = fixture.port.acquire(owner, request(1))

    expect(initial.rows[0]?.usage).toEqual({
      status: 'pending',
      reason: 'identity-pending',
    })
    expect(fixture.acquired).toHaveLength(0)

    fixture.sourceChanged()
    expect(fixture.acquired).toHaveLength(1)
    expect(fixture.port.snapshot(owner, 1).rows[0]?.usage).toEqual({
      status: 'pending',
      reason: 'observation-pending',
    })
    fixture.port.release(owner, 1)
  })

  it('bounds admitted provider observers while retaining an explicit state for every row', () => {
    const fixture = createFixture()
    const targets = Array.from({ length: 110 }, (_, index) => ({
      handle: asSessionsTerminalHandle(`terminal-${index}`),
      livePty: {
        handle: asSessionsPtyHandle(`instance-${index}`),
        rendererOwnerId: owner.id,
        rendererGeneration: owner.generation,
      },
    }))
    fixture.resolveTargets.mockImplementation((_owner, input) =>
      input.targets.map((target) => ({
        ...target,
        providerId,
        usageSupported: true,
        connectionState: 'connected' as const,
      })),
    )
    fixture.resolveUsageObservation.mockImplementation((id, instanceId) => ({
      status: 'available' as const,
      target: {
        instanceId,
        providerId,
        host: fixture.host,
        sessionId: `00000000-0000-4000-8000-${id.slice(-3).padStart(12, '0')}`,
        cwd: hostPath(fixture.host.hostId, '/repo'),
        artifact: { identity: 'artifact', environment: {}, unsetEnvironment: [] },
      },
    }))
    const snapshot = fixture.port.acquire(owner, { ...request(3), targets })

    expect(snapshot.rows).toHaveLength(110)
    expect(fixture.acquired).toHaveLength(96)
    expect(
      snapshot.rows.filter(
        (row) =>
          row.usage.status === 'unavailable' &&
          row.usage.reason === 'observation-capacity',
      ),
    ).toHaveLength(14)
    fixture.port.release(owner, 3)
    expect(fixture.releases.every((release) => release.mock.calls.length === 1)).toBe(
      true,
    )
  })
})

function createFixture(host = projectHost('local')) {
  let sourceChanged: () => void = () => undefined
  const stopSourceObservation = vi.fn()
  const acquired: HarnessUsageDemand[] = []
  const releases: ReturnType<typeof vi.fn>[] = []
  const emit = vi.fn()
  const resolveTargets = vi.fn((_owner, input: SessionsUsageDemandRequest) =>
    input.targets.map((target) => ({
      ...target,
      providerId,
      usageSupported: true,
      connectionState: 'connected' as const,
    })),
  )
  const resolveUsageObservation = vi.fn(
    (_id: string, _instanceId: string): PtyUsageObservationResolution => ({
      status: 'available',
      target: {
        instanceId: 'instance-1',
        providerId,
        host,
        sessionId: '00000000-0000-4000-8000-000000000001',
        cwd: hostPath(host.hostId, '/repo'),
        artifact: { identity: 'artifact', environment: {}, unsetEnvironment: [] },
      },
    }),
  )
  const currentUsageTargets = vi.fn(
    (
      _owner: typeof owner,
      _generation: number,
      _targets: SessionsUsageDemandRequest['targets'],
    ): readonly SessionsResolvedUsageTarget[] => {
      throw new Error('exact target changed')
    },
  )
  const port = new SessionsUsageObservationPort({
    sessions: {
      resolveUsageTargets: resolveTargets,
      currentUsageTargets,
      observeSourceChanges: (listener) => {
        sourceChanged = listener
        return stopSourceObservation
      },
    },
    ptys: { resolveUsageObservation },
    usage: {
      acquire: (demand) => {
        acquired.push(demand)
        const release = vi.fn()
        releases.push(release)
        demand.emit({
          version: 1,
          observedAt: 1,
          source: { providerId, kind: 'session-artifact', provenance: 'pending' },
          freshness: { state: 'live', staleAfterMs: 30_000 },
          facets: {
            session: { status: 'unsupported' },
            model: { status: 'unsupported' },
            context: { status: 'unsupported' },
            usage: { status: 'pending' },
            turn: { status: 'unsupported' },
            integrations: { status: 'unsupported' },
          },
        })
        return release
      },
    },
    emit,
    now: () => 100,
  })
  return {
    port,
    host,
    acquired,
    releases,
    emit,
    resolveTargets,
    resolveUsageObservation,
    currentUsageTargets,
    stopSourceObservation,
    sourceChanged: () => sourceChanged(),
  }
}

function request(demandGeneration: number): SessionsUsageDemandRequest {
  return {
    demandGeneration,
    projectionDemandGeneration: 5,
    sourceRevision: 7,
    targets: [
      {
        handle: asSessionsTerminalHandle('terminal-1'),
        livePty: {
          handle: asSessionsPtyHandle('instance-1'),
          rendererOwnerId: owner.id,
          rendererGeneration: owner.generation,
        },
      },
    ],
  }
}

function projectHost(id: string): ProjectHost {
  return {
    hostId: asHostId(id),
    connectionState: 'connected',
  } as ProjectHost
}
