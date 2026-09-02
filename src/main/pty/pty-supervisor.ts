/**
 * PTY supervisor (ADR-006).
 *
 * The single module through which every PTY is spawned. It owns the PTY
 * registry, fans terminal output out to attached renderer streams, tracks exit,
 * and is the ONLY permitted caller of `ProjectHost.spawnPty` (enforced by lint).
 * Because all PTY lifecycle funnels through here, a future out-of-process PTY
 * daemon could replace this module without touching the UI.
 */

import { randomUUID } from 'node:crypto'

import {
  contextStatusHarnessSnapshot,
  hostPathEquals,
  LOCAL_HOST_ID,
  type ComposerSubmitMode,
  type HarnessTelemetry,
  type HarnessProfileId,
  type HarnessLaunchMode,
  type HarnessProviderId,
  type HarnessProviderCapabilities,
  type HostId,
  type HostPath,
  type TerminalIdentityStatus,
  TerminalStartAdmission,
} from '../../shared'
import {
  PtyWriteIndeterminateError,
  type Disposer,
  type ProjectHost,
  type PtyExit,
  type PtyProcess,
} from '../project-host'
import {
  harnessProviderCapabilities,
  type HarnessArtifactContext,
  type HarnessLaunchSpec,
  type HarnessProvider,
  type HarnessSessionDiscovery,
} from '../harness/harness-provider'
import { harnessShellCommandArgs } from '../harness/harness-shell-environment'

export interface PtySpawnRequest {
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  /** Precomposed profile launch; tests/legacy callers may omit it. */
  readonly launchSpec?: HarnessLaunchSpec
  readonly unsetEnvironment?: readonly string[]
  readonly artifact?: HarnessArtifactContext
  readonly effectiveCapabilities?: HarnessProviderCapabilities
  /** Exact active profile contract for provider-owned delivery capabilities. */
  readonly profileId?: HarnessProfileId
  readonly launchRevision?: number
  readonly providerContractVersion?: number
  readonly composerSubmitMode?: ComposerSubmitMode
  readonly cwd: HostPath
  /** Mutable presentation/authority owner; launch cwd remains immutable. */
  readonly workspaceRoot?: HostPath
  /** Electron webContents id that owns and may control this PTY. */
  readonly ownerId: number
  /** Main-owned document generation for the renderer attachment. */
  readonly ownerGeneration?: number
  /** hvir's PTY registry id; generated if omitted. */
  readonly sessionId?: string
  /** Exact harness-owned session id, when distinct from the PTY id. */
  readonly harnessSessionId?: string
  /** Resume `harnessSessionId` via the provider rather than launching fresh. */
  readonly resume?: boolean
  /** Provider-neutral launch path. Omitted only by legacy fresh/resume callers. */
  readonly launchMode?: HarnessLaunchMode
  /** Exact provider-owned identity from which a fork is derived. */
  readonly parentHarnessSessionId?: string
  /** Only explicit bulk recovery enters the bounded per-host admission queue. */
  readonly admission?: 'interactive' | 'bulk'
  readonly cols?: number
  readonly rows?: number
  /** Re-probe once when the login-interactive shell reports a missing executable. */
  readonly onClassifiedLaunchFailure?: () => void
}

/** Immutable, serializable description of a managed PTY session. */
export interface ManagedPty {
  /** Unique to this live spawn even when a persisted terminal id is reused. */
  readonly instanceId: string
  readonly id: string
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly hostId: HostId
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly providerId: HarnessProviderId
  readonly capabilities: HarnessProviderCapabilities
  readonly profileId?: HarnessProfileId
  readonly launchRevision?: number
  readonly providerContractVersion?: number
  readonly composerSubmitMode?: ComposerSubmitMode
  readonly pid: number
  readonly startedAt: number
  readonly resumed: boolean
  readonly harnessSessionId?: string
  readonly identityStatus: HarnessSessionIdentityStatus
  /** Sticky once provider-owned observation contradicts the registered identity. */
  readonly identityDiverged?: true
}

export interface ObservedManagedPty {
  readonly info: ManagedPty
  readonly telemetry?: HarnessTelemetry
}

export interface PtyObservationSource {
  observationSnapshot(): readonly ObservedManagedPty[]
  observe(listener: () => void): Disposer
}

export type PtyUsageObservationResolution =
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available'
      readonly target: {
        readonly instanceId: string
        readonly providerId: HarnessProviderId
        readonly host: ProjectHost
        readonly sessionId: string
        readonly cwd: HostPath
        readonly sessionData?: unknown
        readonly artifact: HarnessArtifactContext
      }
    }

export interface PtyUsageObservationSource {
  resolveUsageObservation(id: string, instanceId: string): PtyUsageObservationResolution
}

export type HarnessSessionIdentityStatus = TerminalIdentityStatus

export interface PtyStreamHandlers {
  onData?: (data: string) => void
  onExit?: (exit: PtyExit) => void
  onTelemetry?: (telemetry: HarnessTelemetry | undefined) => void
}

interface Entry {
  info: ManagedPty
  readonly pty: PtyProcess
  readonly usage: {
    readonly host: ProjectHost
    readonly artifact: HarnessArtifactContext
    sessionData?: unknown
  }
  readonly dataListeners: Set<(data: string) => void>
  readonly exitListeners: Set<(exit: PtyExit) => void>
  readonly telemetryListeners: Set<(telemetry: HarnessTelemetry | undefined) => void>
  readonly disposers: Disposer[]
  readonly replay: string[]
  replayLength: number
  replayPending: boolean
  telemetry?: HarnessTelemetry
  telemetryStarted: boolean
  identityDiscoveryActive: boolean
  identityRetryPending: boolean
  launchDiagnostic: string
  identityRetry?: IdentityRetry
  rendererReattachPending: boolean
  exited: boolean
}

interface IdentityRetry {
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  readonly discovery: HarnessSessionDiscovery
  readonly snapshot: unknown
  readonly cwd: HostPath
  readonly launchedAtMs: number
  readonly artifact: HarnessArtifactContext
}

interface PendingEntry {
  readonly token: symbol
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly workspaceRoot: HostPath
  readonly controller: AbortController
  cancelled: boolean
}

interface PendingPtyExit {
  readonly promise: Promise<void>
  readonly dispose: Disposer
}

const MAX_INITIAL_REPLAY_LENGTH = 256 * 1024
const LAUNCH_FAILURE_WINDOW_MS = 30_000

export type PtySupervisorDiagnostic =
  | {
      readonly kind: 'pty-spawned' | 'pty-spawn-failed'
      readonly hostKind: 'local' | 'ssh'
      readonly launchMode: HarnessLaunchMode
    }
  | {
      readonly kind: 'pty-exited'
      readonly hostKind: 'local' | 'ssh'
      readonly launchMode: HarnessLaunchMode
      readonly exitKind: 'clean' | 'error' | 'signal'
      readonly lifetime: 'under-30s' | 'under-5m' | '5m-or-more'
    }

export interface PtySupervisorOptions {
  readonly onDiagnostic?: (event: PtySupervisorDiagnostic) => void
  readonly bulkStartConcurrencyPerHost?: number
  readonly registerSessionIdentity?: (
    terminalId: string,
    harnessSessionId: string,
  ) => Promise<boolean>
  readonly cancelSessionIdentityRegistration?: (terminalId: string) => void
}

export type PtyStartUnavailableReason = 'identity-baseline-unavailable'

export class PtyStartUnavailableError extends Error {
  readonly retryable = true

  constructor(
    readonly reason: PtyStartUnavailableReason,
    cause?: unknown,
  ) {
    super('Harness launch identity baseline is unavailable', { cause })
  }
}

export class PtySupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingIds = new Map<string, PendingEntry>()
  private generation = 0
  private readonly globalExitListeners = new Set<
    (info: ManagedPty, exit: PtyExit) => void
  >()
  private readonly identityListeners = new Set<(info: ManagedPty) => void>()
  private readonly observationListeners = new Set<() => void>()
  private readonly discoveryQueues = new Map<string, Promise<void>>()
  private readonly discoveryControllers = new Set<AbortController>()
  private readonly identityAcceptances = new Set<Promise<boolean>>()
  private readonly startAdmission: TerminalStartAdmission

  constructor(private readonly options: PtySupervisorOptions = {}) {
    this.startAdmission = new TerminalStartAdmission(
      options.bulkStartConcurrencyPerHost ?? 2,
    )
  }

  /** Spawn a PTY. The one and only site that calls `host.spawnPty`. */
  async spawn(req: PtySpawnRequest): Promise<ManagedPty> {
    const sessionId = req.sessionId ?? randomUUID()
    const effectiveCapabilities =
      req.effectiveCapabilities ?? harnessProviderCapabilities(req.provider)
    const requestedLaunchMode = req.launchMode ?? (req.resume === true ? 'resume' : 'fresh')
    const resumed = requestedLaunchMode === 'resume' && effectiveCapabilities.exactResume
    const forked = requestedLaunchMode === 'fork'
    if (
      forked &&
      (effectiveCapabilities.exactFork !== true ||
        !req.provider.fork ||
        !req.parentHarnessSessionId)
    ) {
      throw new Error(`Harness '${req.provider.manifest.id}' fork is not available`)
    }
    const launchMode: HarnessLaunchMode = forked
      ? 'fork'
      : resumed
        ? 'resume'
        : 'fresh'
    const diagnosticContext = {
      hostKind: req.host.hostId === LOCAL_HOST_ID ? ('local' as const) : ('ssh' as const),
      launchMode,
    }
    if (this.entries.has(sessionId) || this.pendingIds.has(sessionId)) {
      this.reportDiagnostic({ kind: 'pty-spawn-failed', ...diagnosticContext })
      throw new Error(`PTY session '${sessionId}' is already active`)
    }
    const pending: PendingEntry = {
      token: Symbol(sessionId),
      ownerId: req.ownerId,
      ownerGeneration: req.ownerGeneration ?? 0,
      workspaceRoot: req.workspaceRoot ?? req.cwd,
      controller: new AbortController(),
      cancelled: false,
    }
    const generation = this.generation
    const artifact = req.artifact ?? {
      identity: `${req.host.hostId}:${req.provider.manifest.id}:default`,
      environment: {},
      unsetEnvironment: [],
    }
    this.pendingIds.set(sessionId, pending)

    const harnessSessionId = resumed
      ? (req.harnessSessionId ??
        (effectiveCapabilities.sessionIdentity === 'preassigned' ? sessionId : undefined))
      : effectiveCapabilities.sessionIdentity === 'preassigned'
        ? sessionId
        : undefined
    if (resumed && !harnessSessionId) {
      this.pendingIds.delete(sessionId)
      this.reportDiagnostic({ kind: 'pty-spawn-failed', ...diagnosticContext })
      throw new Error(
        `Harness '${req.provider.manifest.id}' resume requires an exact session id`,
      )
    }

    const discovery =
      !resumed && effectiveCapabilities.sessionIdentity === 'discovered'
        ? req.provider.sessionDiscovery
        : undefined
    let discoverySnapshot: unknown
    let discoveryReady = false
    let releaseDiscoveryLaunch: Disposer | undefined
    let releaseStartAdmission: Disposer | undefined
    let pty: PtyProcess
    let launchedAtMs: number
    try {
      if (req.admission === 'bulk') {
        releaseStartAdmission = await this.startAdmission.acquire(
          req.host.hostId,
          pending.controller.signal,
        )
        this.assertPending(sessionId, pending, generation)
      }
      if (discovery) {
        releaseDiscoveryLaunch = await this.reserveDiscoveryLaunch(
          `${req.host.hostId}:${req.provider.manifest.id}`,
        )
        this.assertPending(sessionId, pending, generation)
        try {
          discoverySnapshot = await discovery.snapshot(req.host, artifact)
          discoveryReady = true
        } catch (error) {
          throw new PtyStartUnavailableError('identity-baseline-unavailable', error)
        }
      }

      this.assertPending(sessionId, pending, generation)
      const defaultShell = await req.host.defaultShell()
      const ctx = {
        sessionId: harnessSessionId ?? sessionId,
        cwd: req.cwd,
        cols: req.cols,
        rows: req.rows,
        defaultShell,
        composerSubmitMode: req.composerSubmitMode,
        effectiveCapabilities,
        parentSessionId: req.parentHarnessSessionId,
      }
      const spec =
        req.launchSpec ??
        (launchMode === 'resume'
          ? req.provider.resume(ctx)
          : launchMode === 'fork'
            ? req.provider.fork!(ctx)
            : req.provider.launch(ctx))
      const launch = spec.shellEnvironment
        ? {
            file: defaultShell,
            args: harnessShellCommandArgs(spec.file, spec.args),
          }
        : spec
      launchedAtMs = Date.now()
      pty = await req.host.spawnPty({
        file: launch.file,
        args: launch.args,
        cwd: req.cwd,
        env: {
          ...spec.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
        },
        unsetEnv: req.unsetEnvironment,
        cols: req.cols,
        rows: req.rows,
      })
      // Keep same-provider baselines ordered through PTY creation, but never
      // hold a later terminal behind the bounded post-launch identity scan.
      void releaseDiscoveryLaunch?.()
      releaseDiscoveryLaunch = undefined
    } catch (error) {
      void releaseDiscoveryLaunch?.()
      if (
        !(error instanceof PtyStartUnavailableError) &&
        !pending.cancelled &&
        this.generation === generation
      ) {
        this.reportDiagnostic({ kind: 'pty-spawn-failed', ...diagnosticContext })
      }
      throw error
    } finally {
      void releaseStartAdmission?.()
      if (this.pendingIds.get(sessionId)?.token === pending.token) {
        this.pendingIds.delete(sessionId)
      }
    }

    if (pending.cancelled || this.generation !== generation) {
      pty.kill()
      throw new Error(`PTY session '${sessionId}' was cancelled before it started`)
    }

    const info: ManagedPty = {
      instanceId: randomUUID(),
      id: sessionId,
      ownerId: req.ownerId,
      ownerGeneration: req.ownerGeneration ?? 0,
      hostId: req.host.hostId,
      cwd: req.cwd,
      workspaceRoot: req.workspaceRoot ?? req.cwd,
      providerId: req.provider.manifest.id,
      capabilities: effectiveCapabilities,
      profileId: req.profileId,
      launchRevision: req.launchRevision,
      providerContractVersion: req.providerContractVersion,
      composerSubmitMode: req.composerSubmitMode,
      pid: pty.pid,
      startedAt: launchedAtMs,
      resumed,
      harnessSessionId,
      identityStatus: identityStatus(
        effectiveCapabilities.sessionIdentity,
        harnessSessionId,
        discoveryReady,
      ),
    }

    const entry: Entry = {
      info,
      pty,
      usage: { host: req.host, artifact },
      dataListeners: new Set(),
      exitListeners: new Set(),
      telemetryListeners: new Set(),
      disposers: [],
      replay: [],
      replayLength: 0,
      replayPending: true,
      telemetryStarted: false,
      identityDiscoveryActive: false,
      identityRetryPending: false,
      launchDiagnostic: '',
      rendererReattachPending: false,
      exited: false,
    }

    // Publish before subscribing so even a host implementation that reports an
    // already-finished PTY synchronously can remove the right registry entry.
    this.entries.set(sessionId, entry)

    entry.disposers.push(
      pty.onData((data) => {
        if (entry.launchDiagnostic.length < 4_096) {
          entry.launchDiagnostic = `${entry.launchDiagnostic}${data}`.slice(0, 4_096)
        }
        if (entry.replayPending && entry.dataListeners.size === 0) {
          retainReplay(entry, data)
        }
        for (const cb of entry.dataListeners) cb(data)
      }),
    )
    entry.disposers.push(
      pty.onExit((exit) => {
        if (entry.exited) return
        entry.exited = true
        if (
          classifiedEarlyExit(
            exit,
            entry.launchDiagnostic,
            Date.now() - entry.info.startedAt,
          )
        ) {
          req.onClassifiedLaunchFailure?.()
        }
        this.reportDiagnostic({
          kind: 'pty-exited',
          ...diagnosticContext,
          exitKind:
            exit.signal !== undefined
              ? 'signal'
              : exit.exitCode === 0
                ? 'clean'
                : 'error',
          lifetime: lifetimeBucket(Date.now() - entry.info.startedAt),
        })
        try {
          for (const cb of entry.exitListeners) cb(exit)
          for (const cb of this.globalExitListeners) cb(entry.info, exit)
        } finally {
          this.cancelPendingIdentity(entry.info.id)
          for (const dispose of entry.disposers) void dispose()
          entry.dataListeners.clear()
          entry.exitListeners.clear()
          entry.telemetryListeners.clear()
          // The registry represents live sessions. Removing an exited entry
          // also permits a later deterministic resume with the same id.
          if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
          this.publishObservation()
        }
      }),
    )

    if (discovery && discoveryReady) {
      const controller = new AbortController()
      this.discoveryControllers.add(controller)
      entry.disposers.push(() => controller.abort())
      entry.identityDiscoveryActive = true
      entry.identityRetry = {
        host: req.host,
        provider: req.provider,
        discovery,
        snapshot: discoverySnapshot,
        cwd: req.cwd,
        launchedAtMs,
        artifact,
      }
      void this.identifySession(
        entry,
        req.host,
        req.provider,
        discovery,
        discoverySnapshot,
        req.cwd,
        launchedAtMs,
        launchedAtMs,
        artifact,
        controller,
      )
    } else if (harnessSessionId) {
      this.startTelemetry(entry, req.host, req.provider, harnessSessionId, artifact)
    }

    this.reportDiagnostic({ kind: 'pty-spawned', ...diagnosticContext })
    this.publishObservation()
    return info
  }

  /** Attach renderer stream handlers. Returns a disposer that detaches them. */
  attach(
    id: string,
    ownerId: number,
    handlers: PtyStreamHandlers,
    ownerGeneration?: number,
  ): Disposer {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    if (handlers.onData) entry.dataListeners.add(handlers.onData)
    if (handlers.onExit) entry.exitListeners.add(handlers.onExit)
    if (handlers.onTelemetry) entry.telemetryListeners.add(handlers.onTelemetry)
    if (handlers.onData && entry.replayPending) {
      entry.replayPending = false
      const replay = entry.replay.splice(0)
      entry.replayLength = 0
      for (const data of replay) handlers.onData(data)
    }
    if (handlers.onData) entry.rendererReattachPending = false
    if (handlers.onTelemetry && entry.telemetry) {
      handlers.onTelemetry(entry.telemetry)
    }
    return () => {
      if (handlers.onData) entry.dataListeners.delete(handlers.onData)
      if (handlers.onExit) entry.exitListeners.delete(handlers.onExit)
      if (handlers.onTelemetry) entry.telemetryListeners.delete(handlers.onTelemetry)
    }
  }

  resolveUsageObservation(id: string, instanceId: string): PtyUsageObservationResolution {
    const entry = this.entries.get(id)
    if (!entry || entry.exited || entry.info.instanceId !== instanceId) {
      return { status: 'unavailable' }
    }
    if (entry.info.identityStatus === 'discovering') {
      return { status: 'pending' }
    }
    if (entry.info.identityStatus !== 'identified' || !entry.info.harnessSessionId) {
      return { status: 'unavailable' }
    }
    return {
      status: 'available',
      target: {
        instanceId: entry.info.instanceId,
        providerId: entry.info.providerId,
        host: entry.usage.host,
        sessionId: entry.info.harnessSessionId,
        cwd: entry.info.cwd,
        sessionData: entry.usage.sessionData,
        artifact: entry.usage.artifact,
      },
    }
  }

  /**
   * Preserve an attached live PTY while replacing only its renderer document.
   * Detached output returns to the bounded replay buffer until the new document attaches.
   */
  transferRendererSession(
    id: string,
    ownerId: number,
    ownerGeneration: number,
    nextOwnerId: number,
    nextOwnerGeneration: number,
  ): boolean {
    const entry = this.entries.get(id)
    if (
      !entry ||
      entry.exited ||
      entry.info.ownerId !== ownerId ||
      entry.info.ownerGeneration !== ownerGeneration ||
      (entry.dataListeners.size === 0 && !entry.rendererReattachPending)
    ) {
      return false
    }
    entry.dataListeners.clear()
    entry.exitListeners.clear()
    entry.telemetryListeners.clear()
    entry.replayPending = true
    entry.rendererReattachPending = true
    entry.info = {
      ...entry.info,
      ownerId: nextOwnerId,
      ownerGeneration: nextOwnerGeneration,
    }
    this.publishObservation()
    return true
  }

  isAwaitingRendererAttachment(
    id: string,
    ownerId: number,
    ownerGeneration: number,
  ): boolean {
    const entry = this.entries.get(id)
    return Boolean(
      entry &&
      !entry.exited &&
      entry.info.ownerId === ownerId &&
      entry.info.ownerGeneration === ownerGeneration &&
      entry.rendererReattachPending &&
      entry.dataListeners.size === 0,
    )
  }

  write(id: string, ownerId: number, data: string, ownerGeneration?: number): void {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    entry.pty.write(data)
    this.retryIdentityAfterInput(entry)
  }

  /** Confirm one complete write at the immediate PTY transport boundary. */
  async writeConfirmed(
    id: string,
    ownerId: number,
    data: string,
    ownerGeneration?: number,
  ): Promise<void> {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    await entry.pty.writeConfirmed(data)
    if (
      entry.exited ||
      this.entries.get(id) !== entry ||
      entry.info.ownerId !== ownerId ||
      (ownerGeneration !== undefined && entry.info.ownerGeneration !== ownerGeneration)
    ) {
      throw new PtyWriteIndeterminateError(
        `PTY session '${id}' exited before write completion`,
      )
    }
    this.retryIdentityAfterInput(entry)
  }

  resize(
    id: string,
    ownerId: number,
    cols: number,
    rows: number,
    ownerGeneration?: number,
  ): void {
    this.requireOwned(id, ownerId, ownerGeneration).pty.resize(cols, rows)
  }

  kill(id: string, ownerId: number, signal?: string, ownerGeneration?: number): void {
    const pending = this.pendingIds.get(id)
    if (
      pending?.ownerId === ownerId &&
      (ownerGeneration === undefined || pending.ownerGeneration === ownerGeneration)
    ) {
      pending.cancelled = true
      pending.controller.abort()
      this.pendingIds.delete(id)
      return
    }
    this.requireOwned(id, ownerId, ownerGeneration).pty.kill(signal)
  }

  get(id: string): ManagedPty | undefined {
    return this.entries.get(id)?.info
  }

  reassignWorkspace(
    id: string,
    ownerId: number,
    sourceRoot: HostPath,
    targetRoot: HostPath,
    ownerGeneration?: number,
  ): ManagedPty {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    if (!hostPathEquals(entry.info.workspaceRoot, sourceRoot)) {
      throw new Error('PTY no longer belongs to the source workspace')
    }
    if (
      sourceRoot.hostId !== targetRoot.hostId ||
      entry.info.hostId !== targetRoot.hostId
    ) {
      throw new Error('PTY cannot move to another host')
    }
    entry.info = { ...entry.info, workspaceRoot: targetRoot }
    this.publishObservation()
    return entry.info
  }

  list(): ManagedPty[] {
    return [...this.entries.values()].map((e) => e.info)
  }

  observationSnapshot(): readonly ObservedManagedPty[] {
    return [...this.entries.values()].map((entry) => ({
      info: entry.info,
      telemetry: entry.telemetry,
    }))
  }

  observe(listener: () => void): Disposer {
    this.observationListeners.add(listener)
    return () => {
      this.observationListeners.delete(listener)
    }
  }

  workspaceSessionIds(root: HostPath): readonly string[] {
    return [
      ...[...this.pendingIds.entries()]
        .filter(([, pending]) => hostPathEquals(pending.workspaceRoot, root))
        .map(([id]) => id),
      ...[...this.entries.entries()]
        .filter(([, entry]) => hostPathEquals(entry.info.workspaceRoot, root))
        .map(([id]) => id),
    ]
  }

  /** Cancel every pending/live PTY owned by one host-qualified workspace. */
  disposeWorkspace(root: HostPath): void {
    for (const [id, pending] of this.pendingIds) {
      if (!hostPathEquals(pending.workspaceRoot, root)) continue
      pending.cancelled = true
      pending.controller.abort()
      this.pendingIds.delete(id)
    }
    let changed = false
    for (const [id, entry] of this.entries) {
      if (hostPathEquals(entry.info.workspaceRoot, root)) {
        changed = this.disposeEntry(id, entry) || changed
      }
    }
    if (changed) this.publishObservation()
  }

  isOwnedBy(id: string, ownerId: number, ownerGeneration?: number): boolean {
    const info = this.entries.get(id)?.info ?? this.pendingIds.get(id)
    return (
      info?.ownerId === ownerId &&
      (ownerGeneration === undefined || info.ownerGeneration === ownerGeneration)
    )
  }

  /** Subscribe to exits across all sessions. Returns an unsubscribe fn. */
  onExit(cb: (info: ManagedPty, exit: PtyExit) => void): Disposer {
    this.globalExitListeners.add(cb)
    return () => {
      this.globalExitListeners.delete(cb)
    }
  }

  /** Subscribe when a post-launch harness identity resolves or fails closed. */
  onSessionIdentity(cb: (info: ManagedPty) => void): Disposer {
    this.identityListeners.add(cb)
    return () => {
      this.identityListeners.delete(cb)
    }
  }

  /** Kill every session while retaining supervisor-lifetime subscriptions. */
  disposeSessions(): void {
    this.beginSessionDisposal(false)
  }

  /** Kill every session and release supervisor-lifetime listeners. */
  disposeAll(): void {
    this.beginSessionDisposal(false)
    this.clearLifetimeListeners()
  }

  /**
   * Kill every session and let native PTY exit callbacks drain before the app
   * process ends. A short bound keeps an unresponsive remote PTY from holding
   * shutdown indefinitely.
   */
  async disposeAllAndWait(timeoutMs = 2_000): Promise<void> {
    const pendingExits = this.beginSessionDisposal(true)
    const identityAcceptances = [...this.identityAcceptances]
    this.clearLifetimeListeners()
    await Promise.all(
      identityAcceptances.map((acceptance) => acceptance.catch(() => false)),
    )
    if (pendingExits.length === 0) return

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(pendingExits.map(({ promise }) => promise)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      for (const pending of pendingExits) void pending.dispose()
    }
  }

  private beginSessionDisposal(waitForExit: boolean): PendingPtyExit[] {
    this.generation++
    for (const controller of this.discoveryControllers) controller.abort()
    this.discoveryControllers.clear()
    for (const pending of this.pendingIds.values()) {
      pending.cancelled = true
      pending.controller.abort()
    }
    this.pendingIds.clear()
    const pendingExits: PendingPtyExit[] = []
    for (const entry of this.entries.values()) {
      this.cancelPendingIdentity(entry.info.id)
      for (const dispose of entry.disposers) void dispose()
      if (waitForExit && !entry.exited) {
        let disposeExit: Disposer = () => undefined
        const promise = new Promise<void>((resolve) => {
          disposeExit = entry.pty.onExit(() => resolve())
        })
        pendingExits.push({ promise, dispose: () => disposeExit() })
      }
      if (!entry.exited) entry.pty.kill()
    }
    this.entries.clear()
    this.publishObservation()
    return pendingExits
  }

  private reportDiagnostic(event: PtySupervisorDiagnostic): void {
    try {
      this.options.onDiagnostic?.(event)
    } catch {
      // Diagnostics is a droppable observer and never owns PTY behavior.
    }
  }

  private clearLifetimeListeners(): void {
    this.globalExitListeners.clear()
    this.identityListeners.clear()
    this.observationListeners.clear()
  }

  /** Kill only the sessions and pending spawns owned by one renderer. */
  disposeOwner(ownerId: number, ownerGeneration?: number): void {
    for (const [id, pending] of this.pendingIds) {
      if (
        pending.ownerId !== ownerId ||
        (ownerGeneration !== undefined && pending.ownerGeneration !== ownerGeneration)
      ) {
        continue
      }
      pending.cancelled = true
      pending.controller.abort()
      this.pendingIds.delete(id)
    }
    let changed = false
    for (const [id, entry] of this.entries) {
      if (
        entry.info.ownerId !== ownerId ||
        (ownerGeneration !== undefined && entry.info.ownerGeneration !== ownerGeneration)
      ) {
        continue
      }
      changed = this.disposeEntry(id, entry) || changed
    }
    if (changed) this.publishObservation()
  }

  /** Cancel one pending/live session when its narrow renderer lease is revoked. */
  disposeSession(id: string, ownerId: number, ownerGeneration?: number): void {
    const pending = this.pendingIds.get(id)
    if (
      pending?.ownerId === ownerId &&
      (ownerGeneration === undefined || pending.ownerGeneration === ownerGeneration)
    ) {
      pending.cancelled = true
      pending.controller.abort()
      this.pendingIds.delete(id)
    }
    const entry = this.entries.get(id)
    if (
      entry?.info.ownerId === ownerId &&
      (ownerGeneration === undefined || entry.info.ownerGeneration === ownerGeneration)
    ) {
      if (this.disposeEntry(id, entry)) this.publishObservation()
    }
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`No PTY session '${id}'`)
    return entry
  }

  private requireOwned(id: string, ownerId: number, ownerGeneration?: number): Entry {
    const entry = this.require(id)
    if (
      entry.info.ownerId !== ownerId ||
      (ownerGeneration !== undefined && entry.info.ownerGeneration !== ownerGeneration)
    ) {
      throw new Error(`PTY session '${id}' belongs to another renderer`)
    }
    return entry
  }

  private disposeEntry(id: string, entry: Entry): boolean {
    this.cancelPendingIdentity(id)
    for (const dispose of entry.disposers) void dispose()
    entry.dataListeners.clear()
    entry.exitListeners.clear()
    entry.telemetryListeners.clear()
    entry.replay.length = 0
    entry.replayLength = 0
    if (!entry.exited) entry.pty.kill()
    if (this.entries.get(id) !== entry) return false
    this.entries.delete(id)
    return true
  }

  private assertPending(id: string, pending: PendingEntry, generation: number): void {
    if (pending.cancelled || this.generation !== generation) {
      throw new Error(`PTY session '${id}' was cancelled before it started`)
    }
  }

  private reserveDiscoveryLaunch(key: string): Promise<Disposer> {
    const previous = this.discoveryQueues.get(key) ?? Promise.resolve()
    let openGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    // Store the reservation before awaiting the previous holder. Concurrent
    // launches cannot snapshot and spawn out of order, but identification is
    // deliberately outside this queue because it may take up to 90 seconds.
    this.discoveryQueues.set(key, tail)

    return previous
      .catch(() => undefined)
      .then(() => {
        let released = false
        return () => {
          if (released) return
          released = true
          openGate?.()
          void tail.then(() => {
            if (this.discoveryQueues.get(key) === tail) {
              this.discoveryQueues.delete(key)
            }
          })
        }
      })
  }

  private async identifySession(
    entry: Entry,
    host: ProjectHost,
    provider: HarnessProvider,
    discovery: HarnessSessionDiscovery,
    snapshot: unknown,
    cwd: HostPath,
    launchedAtMs: number,
    discoveryStartedAtMs: number,
    artifact: HarnessArtifactContext,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await discovery.identify(host, snapshot, {
        cwd,
        launchedAtMs,
        discoveryStartedAtMs,
        signal: controller.signal,
        artifact,
      })
      if (entry.exited || this.entries.get(entry.info.id) !== entry) return
      if (result.status === 'identified') {
        entry.usage.sessionData = result.sessionData
        let accepted = false
        try {
          accepted = await this.registerIdentity(entry.info.id, result.sessionId)
        } catch {
          // The registry owns persistence diagnostics. Publication stays unavailable.
        }
        if (!entry.exited && this.entries.get(entry.info.id) === entry) {
          entry.info = accepted
            ? {
                ...entry.info,
                harnessSessionId: result.sessionId,
                identityStatus: 'identified',
              }
            : {
                ...entry.info,
                harnessSessionId: undefined,
                identityStatus: 'unavailable',
              }
          if (accepted) {
            entry.identityRetry = undefined
            entry.identityRetryPending = false
            this.startTelemetry(
              entry,
              host,
              provider,
              result.sessionId,
              artifact,
              result.sessionData,
            )
          }
        }
      } else if (result.status === 'ambiguous') {
        entry.info = { ...entry.info, identityStatus: result.status }
        entry.identityRetry = undefined
        entry.identityRetryPending = false
      } else {
        entry.info = { ...entry.info, identityStatus: result.status }
      }
    } catch (error) {
      if (!entry.exited && this.entries.get(entry.info.id) === entry) {
        entry.info = { ...entry.info, identityStatus: 'unavailable' }
      }
      if (!controller.signal.aborted) {
        console.warn(
          `[pty] ${entry.info.providerId} session discovery unavailable`,
          error,
        )
      }
    } finally {
      entry.identityDiscoveryActive = false
      this.discoveryControllers.delete(controller)
    }
    if (entry.exited || this.entries.get(entry.info.id) !== entry) return
    for (const cb of this.identityListeners) cb(entry.info)
    this.publishObservation()
    if (
      entry.identityRetryPending &&
      entry.info.identityStatus === 'unavailable' &&
      entry.identityRetry
    ) {
      entry.identityRetryPending = false
      this.retryIdentityAfterInput(entry)
    }
  }

  private retryIdentityAfterInput(entry: Entry): void {
    const retry = entry.identityRetry
    if (
      !retry ||
      entry.exited ||
      entry.info.identityStatus === 'identified' ||
      this.entries.get(entry.info.id) !== entry
    ) {
      return
    }
    if (entry.identityDiscoveryActive) {
      entry.identityRetryPending = true
      return
    }
    entry.identityDiscoveryActive = true
    entry.info = { ...entry.info, identityStatus: 'discovering' }
    for (const cb of this.identityListeners) cb(entry.info)
    this.publishObservation()

    const controller = new AbortController()
    this.discoveryControllers.add(controller)
    entry.disposers.push(() => controller.abort())
    void this.identifySession(
      entry,
      retry.host,
      retry.provider,
      retry.discovery,
      retry.snapshot,
      retry.cwd,
      retry.launchedAtMs,
      Date.now(),
      retry.artifact,
      controller,
    )
  }

  private registerIdentity(
    terminalId: string,
    harnessSessionId: string,
  ): Promise<boolean> {
    const acceptance = Promise.resolve().then(
      () => this.options.registerSessionIdentity?.(terminalId, harnessSessionId) ?? true,
    )
    this.identityAcceptances.add(acceptance)
    void acceptance
      .catch(() => false)
      .finally(() => this.identityAcceptances.delete(acceptance))
    return acceptance
  }

  private cancelPendingIdentity(terminalId: string): void {
    this.options.cancelSessionIdentityRegistration?.(terminalId)
  }

  private startTelemetry(
    entry: Entry,
    host: ProjectHost,
    provider: HarnessProvider,
    sessionId: string,
    artifact: HarnessArtifactContext,
    sessionData?: unknown,
  ): void {
    const observer = provider.telemetry
    if (!observer || entry.telemetryStarted) return
    entry.telemetryStarted = true
    const controller = new AbortController()
    entry.disposers.push(() => controller.abort())
    const publishTelemetry = (telemetry: HarnessTelemetry | undefined): void => {
      if (
        controller.signal.aborted ||
        entry.exited ||
        this.entries.get(entry.info.id) !== entry
      ) {
        return
      }
      entry.telemetry = telemetry
      for (const cb of entry.telemetryListeners) cb(telemetry)
      this.publishObservation()
    }
    const publishIdentityDivergence = (): void => {
      if (
        controller.signal.aborted ||
        entry.exited ||
        this.entries.get(entry.info.id) !== entry ||
        entry.info.identityDiverged
      ) {
        return
      }
      entry.info = { ...entry.info, identityDiverged: true }
      for (const cb of this.identityListeners) cb(entry.info)
      this.publishObservation()
    }
    void Promise.resolve()
      .then(() =>
        observer.observe(host, {
          subscriptionId: entry.info.id,
          sessionId,
          cwd: entry.info.cwd,
          sessionData,
          artifact,
          signal: controller.signal,
          emit: publishTelemetry,
          identityDiverged: publishIdentityDivergence,
        }),
      )
      .then(
        (dispose) => {
          if (
            controller.signal.aborted ||
            entry.exited ||
            this.entries.get(entry.info.id) !== entry
          ) {
            void dispose()
          } else {
            entry.disposers.push(dispose)
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            console.warn(`[pty] ${provider.manifest.id} telemetry unavailable`, error)
            publishTelemetry(
              contextStatusHarnessSnapshot({
                providerId: provider.manifest.id,
                provenance: 'Harness telemetry observer lifecycle',
                sessionId,
                context: {
                  status: 'unavailable',
                  reason: 'Harness telemetry observer unavailable',
                },
              }),
            )
          }
        },
      )
  }

  private publishObservation(): void {
    for (const listener of this.observationListeners) listener()
  }
}

function lifetimeBucket(elapsedMs: number): 'under-30s' | 'under-5m' | '5m-or-more' {
  if (elapsedMs < 30_000) return 'under-30s'
  if (elapsedMs < 5 * 60_000) return 'under-5m'
  return '5m-or-more'
}

function classifiedEarlyExit(exit: PtyExit, output: string, elapsedMs: number): boolean {
  if (elapsedMs > LAUNCH_FAILURE_WINDOW_MS) return false
  return (
    exit.exitCode === 126 ||
    exit.exitCode === 127 ||
    /unknown option|unrecognized option|unsupported option|unsupported version|requires (?:a )?newer version/i.test(
      output,
    )
  )
}

function identityStatus(
  sessionIdentity: HarnessProviderCapabilities['sessionIdentity'],
  harnessSessionId: string | undefined,
  discoveryReady: boolean,
): HarnessSessionIdentityStatus {
  if (sessionIdentity === 'none') return 'none'
  if (harnessSessionId) return 'identified'
  return discoveryReady ? 'discovering' : 'unavailable'
}

function retainReplay(entry: Entry, data: string): void {
  if (data.length >= MAX_INITIAL_REPLAY_LENGTH) {
    entry.replay.splice(0, entry.replay.length, data.slice(-MAX_INITIAL_REPLAY_LENGTH))
    entry.replayLength = MAX_INITIAL_REPLAY_LENGTH
    return
  }
  entry.replay.push(data)
  entry.replayLength += data.length
  while (entry.replayLength > MAX_INITIAL_REPLAY_LENGTH && entry.replay.length > 0) {
    const overflow = entry.replayLength - MAX_INITIAL_REPLAY_LENGTH
    const first = entry.replay[0] ?? ''
    if (first.length <= overflow) {
      entry.replay.shift()
      entry.replayLength -= first.length
    } else {
      entry.replay[0] = first.slice(overflow)
      entry.replayLength -= overflow
    }
  }
}
