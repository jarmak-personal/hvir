import { describe, expect, it, vi } from 'vitest'

import {
  HarnessUsageDemandController,
  MAX_HARNESS_USAGE_DEMAND_TARGETS,
  type HarnessUsageDemand,
} from '../src/main/harness/harness-usage-demand-controller'
import {
  plainShellProvider,
  type HarnessProvider,
} from '../src/main/harness/harness-provider'
import { usageObservationHarnessTelemetry } from '../src/main/harness/harness-usage'
import type { ProjectHost } from '../src/main/project-host'
import {
  asHarnessProviderId,
  asHostId,
  hostPath,
  type HarnessTelemetry,
} from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

const PROVIDER_ID = asHarnessProviderId('test-usage')
const SESSION_ID = '019ab123-4567-7890-abcd-ef0123456789'

describe('HarnessUsageDemandController', () => {
  it('shares one provider observer until the final named lease is released', async () => {
    const fixture = demandFixture()
    const first = vi.fn<(value: HarnessTelemetry) => void>()
    const second = vi.fn<(value: HarnessTelemetry) => void>()
    const stopFirst = fixture.controller.acquire(fixture.demand('first', 1, first))
    const stopSecond = fixture.controller.acquire(fixture.demand('second', 1, second))

    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce())
    fixture.emit?.(usage(10))
    await Promise.resolve()
    expect(first.mock.calls.at(-1)?.[0].facets.usage.status).toBe('exact')
    expect(second.mock.calls.at(-1)?.[0].facets.usage.status).toBe('exact')

    await stopFirst()
    expect(fixture.signal?.aborted).toBe(false)
    await stopSecond()
    expect(fixture.signal?.aborted).toBe(true)
    expect(fixture.disposeObserver).toHaveBeenCalledOnce()
  })

  it('coalesces bursts and rejects late results after generation revocation', async () => {
    const fixture = demandFixture()
    const emitted = vi.fn<(value: HarnessTelemetry) => void>()
    fixture.controller.acquire(fixture.demand('renderer', 4, emitted))
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce())
    for (let index = 1; index <= 100; index += 1) fixture.emit?.(usage(index))
    await Promise.resolve()
    expect(emitted).toHaveBeenCalledTimes(2)
    expect(exactTotal(emitted.mock.calls.at(-1)?.[0])).toBe(400)

    fixture.controller.releaseOwner('renderer', 1)
    fixture.emit?.(usage(200))
    await Promise.resolve()
    expect(emitted).toHaveBeenCalledTimes(2)
    expect(fixture.signal?.aborted).toBe(true)
  })

  it('does not start a provider observer after immediate revocation', async () => {
    const fixture = demandFixture()
    const stop = fixture.controller.acquire(
      fixture.demand('renderer', 1, () => undefined),
    )
    await stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.observe).not.toHaveBeenCalled()
  })

  it('disposes a provider observer that completes after revocation', async () => {
    const fixture = demandFixture({ deferredObserver: true })
    const stop = fixture.controller.acquire(
      fixture.demand('renderer', 1, () => undefined),
    )
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce())
    await stop()
    fixture.finishObserver()
    await vi.waitFor(() => expect(fixture.disposeObserver).toHaveBeenCalledOnce())
  })

  it('revokes older demand and renderer generations before admitting successors', async () => {
    const fixture = demandFixture()
    const oldEmit = vi.fn<(value: HarnessTelemetry) => void>()
    fixture.controller.acquire(fixture.demand('renderer', 1, oldEmit))
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce())
    const firstSignal = fixture.signal

    fixture.controller.acquire(fixture.demand('renderer', 2, () => undefined, 'pty-2'))
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)
    const secondSignal = fixture.signal

    fixture.controller.acquire(fixture.demand('renderer', 1, () => undefined, 'pty-3', 2))
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledTimes(3))
    expect(secondSignal?.aborted).toBe(true)
    expect(() =>
      fixture.controller.acquire(
        fixture.demand('renderer', 3, () => undefined, 'pty-stale', 1),
      ),
    ).toThrow('renderer generation is stale')
  })

  it('keeps unsupported and disconnected capabilities explicit without starting work', async () => {
    const unsupported = demandFixture({ supported: false })
    const unsupportedEmit = vi.fn<(value: HarnessTelemetry) => void>()
    unsupported.controller.acquire(unsupported.demand('renderer', 1, unsupportedEmit))
    expect(unsupportedEmit.mock.calls[0]?.[0].facets.usage).toEqual({
      status: 'unsupported',
    })
    expect(unsupported.observe).not.toHaveBeenCalled()

    const disconnected = demandFixture({ connectionState: 'disconnected' })
    const disconnectedEmit = vi.fn<(value: HarnessTelemetry) => void>()
    const stopDisconnected = disconnected.controller.acquire(
      disconnected.demand('renderer', 1, disconnectedEmit),
    )
    await Promise.resolve()
    expect(disconnectedEmit.mock.calls.at(-1)?.[0].facets.usage).toEqual({
      status: 'unavailable',
      reason: 'host-disconnected',
    })
    expect(disconnected.observe).not.toHaveBeenCalled()

    await stopDisconnected()
    disconnected.setConnectionState('connected')
    disconnected.controller.acquire(disconnected.demand('renderer', 2, () => undefined))
    await vi.waitFor(() => expect(disconnected.observe).toHaveBeenCalledOnce())
  })

  it('bounds many-session state and cleans every admitted observer', async () => {
    const fixture = demandFixture()
    const stops = Array.from({ length: MAX_HARNESS_USAGE_DEMAND_TARGETS }, (_, index) =>
      fixture.controller.acquire(
        fixture.demand(`owner-${index}`, 1, () => undefined, `pty-${index}`),
      ),
    )
    await vi.waitFor(() =>
      expect(fixture.observe).toHaveBeenCalledTimes(MAX_HARNESS_USAGE_DEMAND_TARGETS),
    )
    expect(() =>
      fixture.controller.acquire(
        fixture.demand('overflow', 1, () => undefined, 'pty-overflow'),
      ),
    ).toThrow('target limit')

    for (const stop of stops) await stop()
    expect(fixture.abortedSignals()).toHaveLength(MAX_HARNESS_USAGE_DEMAND_TARGETS)
    expect(fixture.abortedSignals().every(Boolean)).toBe(true)
    expect(fixture.disposeObserver).toHaveBeenCalledTimes(
      MAX_HARNESS_USAGE_DEMAND_TARGETS,
    )
  })

  it('uses the same demand and cleanup contract for a connected SshHost', async () => {
    const host = createTestSshHost({
      config: {
        alias: 'usage-remote',
        hostname: 'remote.test',
        user: 'picard',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const connection = vi
      .spyOn(host, 'connectionState', 'get')
      .mockReturnValue('connected')
    const fixture = demandFixture({ host })
    const emitted = vi.fn<(value: HarnessTelemetry) => void>()
    const stop = fixture.controller.acquire(fixture.demand('renderer', 1, emitted))
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce())
    expect(fixture.observe.mock.calls[0]?.[0]).toBe(host)
    fixture.emit?.(usage(5))
    await Promise.resolve()
    expect(exactTotal(emitted.mock.calls.at(-1)?.[0])).toBe(20)

    await stop()
    expect(fixture.signal?.aborted).toBe(true)
    connection.mockRestore()
    await host.dispose()
  })
})

function demandFixture(
  options: {
    readonly supported?: boolean
    readonly connectionState?: ProjectHost['connectionState']
    readonly deferredObserver?: boolean
    readonly host?: ProjectHost
  } = {},
) {
  let emit: ((value: HarnessTelemetry | undefined) => void) | undefined
  let signal: AbortSignal | undefined
  const signals: AbortSignal[] = []
  const disposeObserver = vi.fn()
  let finishObserver: ((dispose: () => void) => void) | undefined
  const observe = vi.fn<NonNullable<HarnessProvider['usageTelemetry']>['observe']>(
    (_host, context) => {
      emit = context.emit
      signal = context.signal
      signals.push(context.signal)
      return options.deferredObserver
        ? new Promise<() => void>((resolve) => {
            finishObserver = resolve
          })
        : disposeObserver
    },
  )
  const provider: HarnessProvider = {
    ...plainShellProvider,
    manifest: { ...plainShellProvider.manifest, id: PROVIDER_ID },
    ...(options.supported === false ? {} : { usageTelemetry: { observe } }),
  }
  const registry = { get: () => provider }
  const hostId = options.host?.hostId ?? asHostId('test-host')
  const host =
    options.host ??
    ({
      hostId,
      connectionState: options.connectionState ?? 'connected',
    } as ProjectHost)
  const controller = new HarnessUsageDemandController(registry)
  return {
    controller,
    observe,
    disposeObserver,
    get emit() {
      return emit
    },
    get signal() {
      return signal
    },
    abortedSignals: () => signals.map((candidate) => candidate.aborted),
    finishObserver: () => finishObserver?.(disposeObserver),
    setConnectionState: (value: ProjectHost['connectionState']) => {
      Object.assign(host, { connectionState: value })
    },
    demand(
      ownerId: string,
      demandGeneration: number,
      consumer: HarnessUsageDemand['emit'],
      instanceId = 'pty-1',
      rendererGeneration = 1,
    ): HarnessUsageDemand {
      return {
        ownerId,
        rendererGeneration,
        demandGeneration,
        target: {
          instanceId,
          providerId: PROVIDER_ID,
          host,
          sessionId: SESSION_ID,
          cwd: hostPath(hostId, '/project'),
          artifact: { identity: 'test-artifact', environment: {}, unsetEnvironment: [] },
        },
        emit: consumer,
      }
    },
  }
}

function usage(value: number): HarnessTelemetry {
  const telemetry = usageObservationHarnessTelemetry({
    providerId: PROVIDER_ID,
    sessionId: SESSION_ID,
    provenance: 'test',
    counters: {
      freshInputTokens: value,
      cacheReadInputTokens: value,
      cacheWriteInputTokens: value,
      outputTokens: value,
    },
  })
  if (!telemetry) throw new Error('Expected exact usage telemetry')
  return telemetry
}

function exactTotal(value: HarnessTelemetry | undefined): number | undefined {
  const usage = value?.facets.usage
  return usage?.status === 'exact' ? usage.value.normalizedTokenTotal : undefined
}
