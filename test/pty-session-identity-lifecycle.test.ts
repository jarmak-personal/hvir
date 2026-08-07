import { describe, expect, it, vi } from 'vitest'

import {
  codexProvider,
  type HarnessProvider,
  type HarnessSessionDiscovery,
} from '../src/main/harness/harness-provider'
import type {
  ProjectHost,
  PtyExit,
  PtyProcess,
  SpawnPtyOptions,
} from '../src/main/project-host'
import { PtyStartUnavailableError, PtySupervisor } from '../src/main/pty/pty-supervisor'
import { LOCAL_HOST_ID, localPath } from '../src/shared'

const OWNER_ID = 305
const CWD = localPath('/tmp/project')

class IdentityPty implements PtyProcess {
  readonly pid = 305
  readonly write = vi.fn<(data: string) => void>()
  readonly writeConfirmed = vi.fn<(data: string) => Promise<void>>(() =>
    Promise.resolve(),
  )
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<(signal?: string) => void>()
  private readonly exitListeners = new Set<(exit: PtyExit) => void>()

  onData(_listener: (data: string) => void): () => void {
    return () => undefined
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  emitExit(exit: PtyExit): void {
    for (const listener of [...this.exitListeners]) listener(exit)
  }
}

function fixture(discovery: HarnessSessionDiscovery): {
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  readonly pty: IdentityPty
  readonly spawnProcess: ReturnType<
    typeof vi.fn<(options: SpawnPtyOptions) => Promise<PtyProcess>>
  >
} {
  const pty = new IdentityPty()
  const spawnProcess = vi.fn((_options: SpawnPtyOptions) => Promise.resolve(pty))
  const host = {
    hostId: LOCAL_HOST_ID,
    defaultShell: () => Promise.resolve('/bin/sh'),
    spawnPty: spawnProcess,
  } as unknown as ProjectHost
  return {
    host,
    pty,
    spawnProcess,
    provider: { ...codexProvider, sessionDiscovery: discovery, telemetry: undefined },
  }
}

function spawn(
  supervisor: PtySupervisor,
  host: ProjectHost,
  provider: HarnessProvider,
  sessionId: string,
) {
  return supervisor.spawn({
    host,
    provider,
    launchSpec: { file: 'codex-fixture', args: [] },
    cwd: CWD,
    ownerId: OWNER_ID,
    sessionId,
  })
}

describe('PTY discovered identity lifecycle', () => {
  it('returns retryable unavailability without launching when the snapshot fails', async () => {
    const diagnostics: string[] = []
    const identify = vi.fn()
    const f = fixture({
      snapshot: () => Promise.reject(new Error('scan failed')),
      identify,
    })
    const supervisor = new PtySupervisor({
      onDiagnostic: (event) => diagnostics.push(event.kind),
    })
    const launch = spawn(supervisor, f.host, f.provider, 'snapshot-failed')

    await expect(launch).rejects.toBeInstanceOf(PtyStartUnavailableError)
    await expect(launch).rejects.toMatchObject({
      reason: 'identity-baseline-unavailable',
      retryable: true,
    })
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(identify).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([])
  })

  it('queues at most one retry when input arrives during active discovery', async () => {
    let finishInitial: (() => void) | undefined
    const identify = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishInitial = () => resolve({ status: 'unavailable' })
          }),
      )
      .mockResolvedValueOnce({
        status: 'identified',
        sessionId: 'codex-after-active-input',
      })
    const f = fixture({ snapshot: () => Promise.resolve([]), identify })
    const supervisor = new PtySupervisor()
    const info = await spawn(supervisor, f.host, f.provider, 'active-input-terminal')
    await vi.waitFor(() => expect(identify).toHaveBeenCalledOnce())

    supervisor.write(info.id, OWNER_ID, 'first')
    supervisor.write(info.id, OWNER_ID, 'second')
    expect(identify).toHaveBeenCalledOnce()
    finishInitial?.()

    await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(supervisor.get(info.id)).toMatchObject({
        harnessSessionId: 'codex-after-active-input',
        identityStatus: 'identified',
      }),
    )
    expect(f.pty.write).toHaveBeenCalledTimes(2)
  })

  it('publishes identity only after registry acceptance', async () => {
    let acceptIdentity: (() => void) | undefined
    const registerSessionIdentity = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acceptIdentity = () => resolve(true)
        }),
    )
    const f = fixture({
      snapshot: () => Promise.resolve([]),
      identify: () =>
        Promise.resolve({ status: 'identified', sessionId: 'accepted-codex-id' }),
    })
    const supervisor = new PtySupervisor({ registerSessionIdentity })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)
    await spawn(supervisor, f.host, f.provider, 'acceptance-terminal')
    await vi.waitFor(() => expect(registerSessionIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('acceptance-terminal')).toMatchObject({
      harnessSessionId: undefined,
      identityStatus: 'discovering',
    })
    expect(onIdentity).not.toHaveBeenCalled()

    acceptIdentity?.()
    await vi.waitFor(() =>
      expect(onIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessSessionId: 'accepted-codex-id',
          identityStatus: 'identified',
        }),
      ),
    )
  })

  it('keeps identity unavailable when registry acceptance fails', async () => {
    const f = fixture({
      snapshot: () => Promise.resolve([]),
      identify: () =>
        Promise.resolve({ status: 'identified', sessionId: 'rejected-codex-id' }),
    })
    const supervisor = new PtySupervisor({
      registerSessionIdentity: () => Promise.reject(new Error('write failed')),
    })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)
    await spawn(supervisor, f.host, f.provider, 'rejected-terminal')

    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('rejected-terminal')).toMatchObject({
      harnessSessionId: undefined,
      identityStatus: 'unavailable',
    })
  })

  it('drains an accepted identity registration during shutdown', async () => {
    let finishAcceptance: (() => void) | undefined
    const f = fixture({
      snapshot: () => Promise.resolve([]),
      identify: () =>
        Promise.resolve({ status: 'identified', sessionId: 'shutdown-codex-id' }),
    })
    const supervisor = new PtySupervisor({
      registerSessionIdentity: () =>
        new Promise<boolean>((resolve) => {
          finishAcceptance = () => resolve(true)
        }),
    })
    await spawn(supervisor, f.host, f.provider, 'shutdown-terminal')
    await vi.waitFor(() => expect(finishAcceptance).toBeTypeOf('function'))

    let disposed = false
    const shutdown = supervisor.disposeAllAndWait(1).then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    finishAcceptance?.()
    await shutdown
    expect(disposed).toBe(true)
  })

  it.each(['PTY exit', 'supervisor disposal'] as const)(
    'cancels active discovery on %s',
    async (event) => {
      let discoverySignal: AbortSignal | undefined
      const f = fixture({
        snapshot: () => Promise.resolve([]),
        identify: (_host, _snapshot, context) =>
          new Promise((resolve) => {
            discoverySignal = context.signal
            context.signal.addEventListener(
              'abort',
              () => resolve({ status: 'unavailable' }),
              { once: true },
            )
          }),
      })
      const supervisor = new PtySupervisor()
      await spawn(supervisor, f.host, f.provider, `cancel-${event.replace(' ', '-')}`)
      await vi.waitFor(() => expect(discoverySignal).toBeDefined())

      if (event === 'PTY exit') {
        f.pty.emitExit({ exitCode: 0, signal: undefined })
      } else {
        supervisor.disposeAll()
      }

      expect(discoverySignal?.aborted).toBe(true)
    },
  )
})
