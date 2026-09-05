import { describe, expect, it, vi } from 'vitest'
import type {
  HarnessSessionDiscoveryContext,
  HarnessSessionDiscoveryResult,
  HarnessTelemetryContext,
} from '../src/main/harness/harness-provider-contract'
import type { Disposer } from '../src/main/project-host/project-host'
import { asHostId, contextStatusHarnessSnapshot, LOCAL_HOST_ID } from '../src/shared'
import {
  createPtySupervisorFixture,
  TestPtyProcess,
} from './fixtures/pty-supervisor-fixture'

describe.each([LOCAL_HOST_ID, asHostId('deterministic-ssh')])(
  'PTY late completion on %s',
  (hostId) => {
    it('releases a cancelled discovery reservation before a replacement launch', async () => {
      const f = createPtySupervisorFixture({ hostId })
      const { spawnPty } = f
      let finishSnapshot: (value: unknown) => void = () => undefined
      const snapshot = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSnapshot = resolve
            }),
        )
        .mockResolvedValue([])
      Object.assign(f.provider, {
        sessionIdentity: 'discovered',
        sessionDiscovery: {
          snapshot,
          identify: () => Promise.resolve({ status: 'unavailable' }),
        },
      })
      const cancelled = f.spawn({ sessionId: 'reused' })
      const rejected = expect(cancelled).rejects.toThrow('cancelled before it started')
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce())
      f.supervisor.disposeWorkspace(f.root)
      const replacement = f.spawn({ sessionId: 'reused' })
      finishSnapshot([])
      await rejected
      const info = await replacement
      expect(spawnPty).toHaveBeenCalledOnce()
      expect(f.supervisor.get('reused')?.instanceId).toBe(info.instanceId)
    })

    it('does not publish an old instance identity when discovery completes after exit', async () => {
      const registerSessionIdentity = vi.fn(() => Promise.resolve(true))
      const f = createPtySupervisorFixture({
        hostId,
        supervisor: { registerSessionIdentity },
      })
      const { spawnPty } = f
      let finish: (result: HarnessSessionDiscoveryResult) => void = () => undefined
      let context: HarnessSessionDiscoveryContext | undefined
      const identify = vi
        .fn()
        .mockImplementationOnce(
          (_host: unknown, _snapshot: unknown, value: HarnessSessionDiscoveryContext) => {
            context = value
            return new Promise<HarnessSessionDiscoveryResult>((resolve) => {
              finish = resolve
            })
          },
        )
        .mockResolvedValue({ status: 'identified', sessionId: 'replacement-identity' })
      Object.assign(f.provider, {
        sessionIdentity: 'discovered',
        sessionDiscovery: { snapshot: () => Promise.resolve([]), identify },
      })
      const old = await f.spawn({ sessionId: 'reused' })
      f.pty.emitExit({ exitCode: 0, signal: undefined })
      expect(context?.signal.aborted).toBe(true)
      spawnPty.mockResolvedValueOnce(new TestPtyProcess())
      const next = await f.spawn({ sessionId: 'reused' })
      await vi.waitFor(() =>
        expect(f.supervisor.get(next.id)?.harnessSessionId).toBe('replacement-identity'),
      )
      finish({ status: 'identified', sessionId: 'old-identity' })
      await Promise.resolve()
      expect(next.instanceId).not.toBe(old.instanceId)
      expect(registerSessionIdentity).toHaveBeenCalledExactlyOnceWith(
        'reused',
        'replacement-identity',
      )
      expect(f.supervisor.get(next.id)?.harnessSessionId).toBe('replacement-identity')
    })

    it('rejects late accepted identity publication for a replaced terminal instance', async () => {
      let accept: (value: boolean) => void = () => undefined
      const registerSessionIdentity = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              accept = resolve
            }),
        )
        .mockResolvedValue(true)
      const cancelSessionIdentityRegistration = vi.fn()
      const f = createPtySupervisorFixture({
        hostId,
        supervisor: { registerSessionIdentity, cancelSessionIdentityRegistration },
      })
      const { spawnPty } = f
      Object.assign(f.provider, {
        sessionIdentity: 'discovered',
        sessionDiscovery: {
          snapshot: () => Promise.resolve([]),
          identify: vi
            .fn()
            .mockResolvedValueOnce({ status: 'identified', sessionId: 'old-identity' })
            .mockResolvedValue({
              status: 'identified',
              sessionId: 'replacement-identity',
            }),
        },
      })
      const old = await f.spawn({ sessionId: 'reused' })
      await vi.waitFor(() => expect(registerSessionIdentity).toHaveBeenCalledOnce())
      f.supervisor.disposeSession(old.id, old.ownerId)
      expect(cancelSessionIdentityRegistration).toHaveBeenCalledExactlyOnceWith(old.id)
      spawnPty.mockResolvedValueOnce(new TestPtyProcess())
      const next = await f.spawn({ sessionId: 'reused' })
      await vi.waitFor(() =>
        expect(f.supervisor.get(next.id)?.harnessSessionId).toBe('replacement-identity'),
      )
      accept(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(f.supervisor.get(next.id)?.harnessSessionId).toBe('replacement-identity')
    })

    it('releases a late observer and suppresses its emissions after workspace disposal', async () => {
      const f = createPtySupervisorFixture({ hostId })
      let finish: (dispose: Disposer) => void = () => undefined
      let context: HarnessTelemetryContext | undefined
      const observe = vi.fn((_host: unknown, value: HarnessTelemetryContext) => {
        context = value
        return new Promise<Disposer>((resolve) => {
          finish = resolve
        })
      })
      Object.assign(f.provider, { telemetry: { observe } })
      const info = await f.spawn()
      await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
      const telemetry = vi.fn()
      f.supervisor.attach(info.id, info.ownerId, { onTelemetry: telemetry })
      f.supervisor.disposeWorkspace(f.root)
      const dispose = vi.fn()
      finish(dispose)
      context?.emit(
        contextStatusHarnessSnapshot({
          providerId: info.providerId,
          sessionId: info.id,
          provenance: 'fixture',
          context: { status: 'pending', reason: 'fixture' },
        }),
      )
      context?.identityDiverged?.()
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
      f.supervisor.disposeWorkspace(f.root)
      expect(context?.signal.aborted).toBe(true)
      expect(telemetry).not.toHaveBeenCalled()
      expect(f.supervisor.list()).toEqual([])
      expect(f.pty.dataListeners.size).toBe(0)
      expect(f.pty.exitListeners.size).toBe(0)
      expect(f.pty.kill).toHaveBeenCalledOnce()
    })
  },
)
