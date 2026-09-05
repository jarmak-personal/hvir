/**
 * Single public authority for live PTYs, renderer generations and workspace binding.
 * Only this facade may call ProjectHost.spawnPty.
 */
import { randomUUID } from 'node:crypto'
import {
  hostPathEquals,
  LOCAL_HOST_ID,
  type HarnessProviderCapabilities,
  type HarnessLaunchMode,
  type HostPath,
} from '../../shared'
import {
  PtyWriteIndeterminateError,
  type Disposer,
  type PtyExit,
  type PtyProcess,
} from '../project-host/project-host'
import { harnessProviderCapabilities } from '../harness/harness-provider-capabilities'
import { harnessShellCommandArgs } from '../harness/harness-shell-environment'
import {
  PtyStartUnavailableError,
  type PtySpawnRequest,
  type ManagedPty,
  type ObservedManagedPty,
  type PtyUsageObservationResolution,
  type HarnessSessionIdentityStatus,
  type PtyStreamHandlers,
  type PtySupervisorDiagnostic,
  type PtySupervisorOptions,
} from './pty-contract'
import { PtyLaunchAdmission } from './pty-launch-admission'
import { PtyStreamAttachment } from './pty-stream-attachment'
import { PtySessionObservation } from './pty-session-observation'
import { PtySessionLifetime, type PendingPtyExit } from './pty-session-lifetime'

export * from './pty-contract'

interface Entry {
  info: ManagedPty
  readonly lifetime: PtySessionLifetime
  readonly stream: PtyStreamAttachment
  readonly observation: PtySessionObservation
  readonly usage: Pick<PtySpawnRequest, 'host'> & {
    readonly artifact: NonNullable<PtySpawnRequest['artifact']>
  }
  rendererReattachPending: boolean
}

export class PtySupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly globalExitListeners = new Set<
    (info: ManagedPty, exit: PtyExit) => void
  >()
  private readonly identityListeners = new Set<(info: ManagedPty) => void>()
  private readonly observationListeners = new Set<() => void>()
  private readonly identityAcceptances = new Set<Promise<boolean>>()
  private readonly admission: PtyLaunchAdmission

  constructor(private readonly options: PtySupervisorOptions = {}) {
    this.admission = new PtyLaunchAdmission(options.bulkStartConcurrencyPerHost ?? 2)
  }

  /** Spawn a PTY. The one and only site that calls `host.spawnPty`. */
  async spawn(req: PtySpawnRequest): Promise<ManagedPty> {
    const sessionId = req.sessionId ?? randomUUID()
    const effectiveCapabilities =
      req.effectiveCapabilities ?? harnessProviderCapabilities(req.provider)
    const requestedLaunchMode =
      req.launchMode ?? (req.resume === true ? 'resume' : 'fresh')
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
    const launchMode: HarnessLaunchMode = forked ? 'fork' : resumed ? 'resume' : 'fresh'
    const diagnosticContext = {
      hostKind: req.host.hostId === LOCAL_HOST_ID ? ('local' as const) : ('ssh' as const),
      launchMode,
    }
    if (this.entries.has(sessionId) || this.admission.has(sessionId)) {
      this.reportDiagnostic({ kind: 'pty-spawn-failed', ...diagnosticContext })
      throw new Error(`PTY session '${sessionId}' is already active`)
    }
    const pending = this.admission.reserve(sessionId, {
      ownerId: req.ownerId,
      ownerGeneration: req.ownerGeneration ?? 0,
      workspaceRoot: req.workspaceRoot ?? req.cwd,
    })
    const artifact = req.artifact ?? {
      identity: `${req.host.hostId}:${req.provider.manifest.id}:default`,
      environment: {},
      unsetEnvironment: [],
    }

    const harnessSessionId = resumed
      ? (req.harnessSessionId ??
        (effectiveCapabilities.sessionIdentity === 'preassigned' ? sessionId : undefined))
      : effectiveCapabilities.sessionIdentity === 'preassigned'
        ? sessionId
        : undefined
    if (resumed && !harnessSessionId) {
      pending.release()
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
        releaseStartAdmission = await this.admission.acquireBulk(
          req.host.hostId,
          pending.signal,
        )
        pending.assertCurrent()
      }
      if (discovery) {
        releaseDiscoveryLaunch = await this.admission.reserveDiscoveryLaunch(
          `${req.host.hostId}:${req.provider.manifest.id}`,
        )
        pending.assertCurrent()
        try {
          discoverySnapshot = await discovery.snapshot(req.host, artifact)
          discoveryReady = true
        } catch (error) {
          throw new PtyStartUnavailableError('identity-baseline-unavailable', error)
        }
      }

      pending.assertCurrent()
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
      if (!(error instanceof PtyStartUnavailableError) && !pending.cancelled) {
        this.reportDiagnostic({ kind: 'pty-spawn-failed', ...diagnosticContext })
      }
      throw error
    } finally {
      void releaseStartAdmission?.()
      pending.release()
    }

    if (pending.cancelled) {
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

    const lifetime = new PtySessionLifetime(pty)
    const stream = new PtyStreamAttachment()
    const isCurrent = (): boolean =>
      lifetime.current && this.entries.get(sessionId) === entry
    const identityChanged = (): void => {
      if (!isCurrent()) return
      for (const cb of this.identityListeners) cb(entry.info)
      this.publishObservation()
    }
    const telemetry = req.provider.telemetry
    const observation = new PtySessionObservation(
      {
        terminalId: sessionId,
        providerId: info.providerId,
        cwd: req.cwd,
        artifact,
        observe: telemetry
          ? (context) => telemetry.observe(req.host, context)
          : undefined,
      },
      {
        isCurrent,
        acceptCandidate: async (harnessSessionId) => {
          let accepted = false
          try {
            accepted = await this.registerIdentity(sessionId, harnessSessionId)
          } finally {
            if (isCurrent()) {
              entry.info = {
                ...entry.info,
                harnessSessionId: accepted ? harnessSessionId : undefined,
                identityStatus: accepted ? 'identified' : 'unavailable',
              }
            }
          }
          return accepted && isCurrent()
        },
        setIdentityStatus: (identityStatus) => {
          if (isCurrent()) entry.info = { ...entry.info, identityStatus }
        },
        identityChanged,
        publishTelemetry: (telemetry) => {
          if (!isCurrent()) return
          stream.publishTelemetry(telemetry)
          this.publishObservation()
        },
        identityDiverged: () => {
          if (!isCurrent() || entry.info.identityDiverged) return
          entry.info = { ...entry.info, identityDiverged: true }
          identityChanged()
        },
      },
    )
    const entry: Entry = {
      info,
      lifetime,
      stream,
      observation,
      usage: { host: req.host, artifact },
      rendererReattachPending: false,
    }

    // Publish before subscribing: hosts may synchronously report an already-finished PTY.
    this.entries.set(sessionId, entry)
    lifetime.own(() => stream.dispose())
    lifetime.own(() => observation.dispose())
    lifetime.own(() => this.cancelPendingIdentity(sessionId))
    stream.start(pty, (data) => lifetime.recordLaunchOutput(data))
    lifetime.start(
      (exit, launchOutput) => {
        if (classifiedEarlyExit(exit, launchOutput, Date.now() - info.startedAt)) {
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
          lifetime: lifetimeBucket(Date.now() - info.startedAt),
        })
        stream.publishExit(exit)
        for (const cb of this.globalExitListeners) cb(entry.info, exit)
      },
      () => {
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
        this.publishObservation()
      },
    )

    if (discovery && discoveryReady) {
      observation.discover(
        (context) => discovery.identify(req.host, discoverySnapshot, context),
        launchedAtMs,
      )
    } else if (harnessSessionId) {
      observation.startTelemetry(harnessSessionId)
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
    const detach = entry.stream.attach(handlers)
    if (handlers.onData) entry.rendererReattachPending = false
    return detach
  }

  resolveUsageObservation(id: string, instanceId: string): PtyUsageObservationResolution {
    const entry = this.entries.get(id)
    if (!entry || !entry.lifetime.current || entry.info.instanceId !== instanceId) {
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
        sessionData: entry.observation.sessionData,
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
      !entry.lifetime.current ||
      entry.info.ownerId !== ownerId ||
      entry.info.ownerGeneration !== ownerGeneration ||
      (!entry.stream.attached && !entry.rendererReattachPending)
    ) {
      return false
    }
    entry.stream.detachForTransfer()
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
      entry.lifetime.current &&
      entry.info.ownerId === ownerId &&
      entry.info.ownerGeneration === ownerGeneration &&
      entry.rendererReattachPending &&
      !entry.stream.attached,
    )
  }

  write(id: string, ownerId: number, data: string, ownerGeneration?: number): void {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    entry.lifetime.write(data)
    entry.observation.retryAfterInput()
  }

  /** Confirm one complete write at the immediate PTY transport boundary. */
  async writeConfirmed(
    id: string,
    ownerId: number,
    data: string,
    ownerGeneration?: number,
  ): Promise<void> {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    await entry.lifetime.writeConfirmed(data)
    if (
      !entry.lifetime.current ||
      this.entries.get(id) !== entry ||
      entry.info.ownerId !== ownerId ||
      (ownerGeneration !== undefined && entry.info.ownerGeneration !== ownerGeneration)
    ) {
      throw new PtyWriteIndeterminateError(
        `PTY session '${id}' exited before write completion`,
      )
    }
    entry.observation.retryAfterInput()
  }

  resize(
    id: string,
    ownerId: number,
    cols: number,
    rows: number,
    ownerGeneration?: number,
  ): void {
    this.requireOwned(id, ownerId, ownerGeneration).lifetime.resize(cols, rows)
  }

  kill(id: string, ownerId: number, signal?: string, ownerGeneration?: number): void {
    if (this.admission.cancelSession(id, ownerId, ownerGeneration)) return
    this.requireOwned(id, ownerId, ownerGeneration).lifetime.kill(signal)
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
      telemetry: entry.observation.telemetry,
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
      ...this.admission.workspaceSessionIds(root),
      ...[...this.entries.entries()]
        .filter(([, entry]) => hostPathEquals(entry.info.workspaceRoot, root))
        .map(([id]) => id),
    ]
  }

  /** Cancel every pending/live PTY owned by one host-qualified workspace. */
  disposeWorkspace(root: HostPath): void {
    this.admission.cancelWorkspace(root)
    let changed = false
    for (const [id, entry] of this.entries) {
      if (hostPathEquals(entry.info.workspaceRoot, root)) {
        changed = this.disposeEntry(id, entry) || changed
      }
    }
    if (changed) this.publishObservation()
  }

  isOwnedBy(id: string, ownerId: number, ownerGeneration?: number): boolean {
    const info = this.entries.get(id)?.info
    return (
      (info?.ownerId === ownerId &&
        (ownerGeneration === undefined || info.ownerGeneration === ownerGeneration)) ||
      this.admission.isOwnedBy(id, ownerId, ownerGeneration)
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
    this.admission.cancelAll()
    const pendingExits: PendingPtyExit[] = []
    for (const entry of this.entries.values()) {
      const pending = entry.lifetime.terminate(waitForExit)
      if (pending) pendingExits.push(pending)
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
    this.admission.cancelOwner(ownerId, ownerGeneration)
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
    this.admission.cancelSession(id, ownerId, ownerGeneration)
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
    entry.lifetime.terminate()
    if (this.entries.get(id) !== entry) return false
    this.entries.delete(id)
    return true
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
  if (elapsedMs > 30_000) return false
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
