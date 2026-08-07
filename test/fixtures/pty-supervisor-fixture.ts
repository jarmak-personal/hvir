import { onTestFinished, vi, type MockInstance } from 'vitest'

import {
  plainShellProvider,
  type HarnessProvider,
} from '../../src/main/harness/harness-provider'
import type {
  ProjectHost,
  PtyExit,
  PtyProcess,
  SpawnPtyOptions,
} from '../../src/main/project-host'
import {
  PtySupervisor,
  type ManagedPty,
  type PtySpawnRequest,
  type PtySupervisorDiagnostic,
  type PtySupervisorOptions,
} from '../../src/main/pty/pty-supervisor'
import {
  LOCAL_HOST_ID,
  asHarnessProviderId,
  hostPath,
  type HostId,
  type HostPath,
} from '../../src/shared'

export const PTY_FIXTURE_OWNER_ID = 17

export class TestPtyProcess implements PtyProcess {
  readonly pid = 4242
  readonly dataListeners = new Set<(data: string) => void>()
  readonly exitListeners = new Set<(exit: PtyExit) => void>()
  readonly write = vi.fn<(data: string) => void>()
  readonly writeConfirmed = vi.fn<(data: string) => Promise<void>>(() =>
    Promise.resolve(),
  )
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<(signal?: string) => void>()

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data)
  }

  emitExit(exit: PtyExit): void {
    for (const cb of [...this.exitListeners]) cb(exit)
  }
}

export interface DeferredPtySpawn {
  readonly pty: TestPtyProcess
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

export interface PtySupervisorFixtureOptions {
  readonly hostId?: HostId
  readonly root?: HostPath
  readonly provider?: HarnessProvider
  readonly onDiagnostic?: (event: PtySupervisorDiagnostic) => void
  readonly supervisor?: Omit<PtySupervisorOptions, 'onDiagnostic'>
}

export interface PtySupervisorFixtureSnapshot {
  readonly sessions: readonly {
    readonly id: string
    readonly hostId: HostId
    readonly cwd: HostPath
    readonly ownerId: number
    readonly ownerGeneration: number
  }[]
  readonly spawns: readonly {
    readonly file: string
    readonly args: readonly string[]
    readonly cwd: HostPath
  }[]
  readonly diagnostics: readonly PtySupervisorDiagnostic[]
}

export interface PtySupervisorFixture {
  readonly supervisor: PtySupervisor
  readonly pty: TestPtyProcess
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  readonly root: HostPath
  readonly diagnostics: readonly PtySupervisorDiagnostic[]
  readonly spawnPty: ReturnType<
    typeof vi.fn<(opts: SpawnPtyOptions) => Promise<PtyProcess>>
  >
  readonly defaultShell: ReturnType<typeof vi.fn<() => Promise<string>>>
  readonly spawn: (overrides?: Partial<PtySpawnRequest>) => Promise<ManagedPty>
  readonly deferNextSpawn: (pty?: TestPtyProcess) => DeferredPtySpawn
  readonly setNow: (value: number) => void
  readonly advanceClock: (milliseconds: number) => void
  readonly snapshot: () => PtySupervisorFixtureSnapshot
  readonly dispose: () => void
}

/** A narrow ProjectHost/provider seam for deterministic PTY lifecycle tests. */
export function createPtySupervisorFixture(
  options: PtySupervisorFixtureOptions | ((event: PtySupervisorDiagnostic) => void) = {},
): PtySupervisorFixture {
  const normalized = typeof options === 'function' ? { onDiagnostic: options } : options
  const hostId = normalized.hostId ?? normalized.root?.hostId ?? LOCAL_HOST_ID
  const root = normalized.root ?? hostPath(hostId, '/tmp/project')
  if (root.hostId !== hostId) {
    throw new Error('PTY fixture root belongs to another host')
  }
  const pty = new TestPtyProcess()
  const spawnPty = vi.fn((_opts: SpawnPtyOptions): Promise<PtyProcess> =>
    Promise.resolve(pty),
  )
  const defaultShell = vi.fn(() => Promise.resolve('/remote/bin/bash'))
  const host = {
    hostId,
    defaultShell,
    spawnPty,
  } as unknown as ProjectHost
  const provider = normalized.provider ?? testHarnessProvider()
  const diagnostics: PtySupervisorDiagnostic[] = []
  const supervisor = new PtySupervisor({
    ...normalized.supervisor,
    onDiagnostic: (event) => {
      diagnostics.push(event)
      normalized.onDiagnostic?.(event)
    },
  })
  let now = 0
  let clock: MockInstance<() => number> | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    supervisor.disposeAll()
    clock?.mockRestore()
  }
  const fixture: PtySupervisorFixture = {
    supervisor,
    pty,
    host,
    provider,
    root,
    diagnostics,
    spawnPty,
    defaultShell,
    spawn: (overrides = {}) =>
      supervisor.spawn({
        host,
        provider,
        cwd: root,
        ownerId: PTY_FIXTURE_OWNER_ID,
        sessionId: 'fixture-session',
        ...overrides,
      }),
    deferNextSpawn: (deferredPty = new TestPtyProcess()) => {
      let resolvePromise: (pty: PtyProcess) => void = () => undefined
      let rejectPromise: (error: unknown) => void = () => undefined
      const pending = new Promise<PtyProcess>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
      })
      spawnPty.mockImplementationOnce(() => pending)
      return {
        pty: deferredPty,
        resolve: () => resolvePromise(deferredPty),
        reject: rejectPromise,
      }
    },
    setNow: (value) => {
      now = value
      clock ??= vi.spyOn(Date, 'now').mockImplementation(() => now)
    },
    advanceClock: (milliseconds) => {
      if (!clock) throw new Error('Call setNow before advancing the PTY fixture clock')
      now += milliseconds
    },
    snapshot: () => ({
      sessions: supervisor.list().map((session) => ({
        id: session.id,
        hostId: session.hostId,
        cwd: session.cwd,
        ownerId: session.ownerId,
        ownerGeneration: session.ownerGeneration,
      })),
      spawns: spawnPty.mock.calls.map(([request]) => ({
        file: request.file,
        args: request.args ?? [],
        cwd: request.cwd,
      })),
      diagnostics: [...diagnostics],
    }),
    dispose,
  }
  onTestFinished(dispose)
  return fixture
}

function testHarnessProvider(): HarnessProvider {
  return {
    manifest: {
      id: asHarnessProviderId('test'),
      displayName: 'Test',
      contextPresentation: 'none',
    },
    profile: {
      version: 1,
      reservedArguments: [],
      reservedEnvironmentKeys: [],
      artifactEnvironmentKeys: [],
      artifactExecutable: false,
      artifactPathBindings: [],
      applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
      classifyRisk: () => 'standard',
    },
    supportsResume: true,
    sessionIdentity: 'preassigned',
    probe: {
      parseVersion: () => undefined,
      effectiveCapabilities: () => ({
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'none',
      }),
    },
    launch: () => ({ file: 'test-harness', args: ['launch'] }),
    resume: () => ({ file: 'test-harness', args: ['resume'] }),
  }
}

export { plainShellProvider }
