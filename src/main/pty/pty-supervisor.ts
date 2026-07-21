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
  type HarnessTelemetry,
  type HarnessProviderId,
  type HarnessProviderCapabilities,
  type HostId,
  type HostPath,
  type TerminalIdentityStatus,
} from '../../shared'
import type { Disposer, ProjectHost, PtyExit, PtyProcess } from '../project-host'
import type {
  HarnessLaunchSpec,
  HarnessProvider,
  HarnessSessionDiscovery,
  HarnessArtifactContext,
} from '../harness/harness-provider'

export interface PtySpawnRequest {
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  /** Precomposed profile launch; tests/legacy callers may omit it. */
  readonly launchSpec?: HarnessLaunchSpec
  readonly unsetEnvironment?: readonly string[]
  readonly artifact?: HarnessArtifactContext
  readonly effectiveCapabilities?: HarnessProviderCapabilities
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
  readonly cols?: number
  readonly rows?: number
  /** Re-probe once when the interactive shell reports a missing executable. */
  readonly onClassifiedLaunchFailure?: () => void
}

/** Immutable, serializable description of a managed PTY session. */
export interface ManagedPty {
  readonly id: string
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly hostId: HostId
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly providerId: HarnessProviderId
  readonly capabilities: HarnessProviderCapabilities
  readonly pid: number
  readonly startedAt: number
  readonly resumed: boolean
  readonly harnessSessionId?: string
  readonly identityStatus: HarnessSessionIdentityStatus
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
  launchDiagnostic: string
  identityRetry?: IdentityRetry
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
  cancelled: boolean
}

interface PendingPtyExit {
  readonly promise: Promise<void>
  readonly dispose: Disposer
}

const MAX_INITIAL_REPLAY_LENGTH = 256 * 1024
const LAUNCH_FAILURE_WINDOW_MS = 30_000

export class PtySupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingIds = new Map<string, PendingEntry>()
  private generation = 0
  private readonly globalExitListeners = new Set<
    (info: ManagedPty, exit: PtyExit) => void
  >()
  private readonly identityListeners = new Set<(info: ManagedPty) => void>()
  private readonly discoveryQueues = new Map<string, Promise<void>>()
  private readonly discoveryControllers = new Set<AbortController>()

  /** Spawn a PTY. The one and only site that calls `host.spawnPty`. */
  async spawn(req: PtySpawnRequest): Promise<ManagedPty> {
    const sessionId = req.sessionId ?? randomUUID()
    if (this.entries.has(sessionId) || this.pendingIds.has(sessionId)) {
      throw new Error(`PTY session '${sessionId}' is already active`)
    }
    const pending: PendingEntry = {
      token: Symbol(sessionId),
      ownerId: req.ownerId,
      ownerGeneration: req.ownerGeneration ?? 0,
      cancelled: false,
    }
    const generation = this.generation
    const effectiveCapabilities = req.effectiveCapabilities ?? {
      sessionIdentity: req.provider.sessionIdentity,
      exactResume: req.provider.supportsResume,
      contextPresentation: req.provider.manifest.contextPresentation,
    }
    const artifact = req.artifact ?? {
      identity: `${req.host.hostId}:${req.provider.manifest.id}:default`,
      environment: {},
      unsetEnvironment: [],
    }
    this.pendingIds.set(sessionId, pending)

    const resumed = req.resume === true && effectiveCapabilities.exactResume
    const harnessSessionId = resumed
      ? (req.harnessSessionId ??
        (effectiveCapabilities.sessionIdentity === 'preassigned' ? sessionId : undefined))
      : effectiveCapabilities.sessionIdentity === 'preassigned'
        ? sessionId
        : undefined
    if (resumed && !harnessSessionId) {
      this.pendingIds.delete(sessionId)
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
    let pty: PtyProcess
    let launchedAtMs: number
    try {
      if (discovery) {
        releaseDiscoveryLaunch = await this.reserveDiscoveryLaunch(
          `${req.host.hostId}:${req.provider.manifest.id}`,
        )
        this.assertPending(sessionId, pending, generation)
        try {
          discoverySnapshot = await discovery.snapshot(req.host, artifact)
          discoveryReady = true
        } catch (error) {
          console.warn(
            `[pty] ${req.provider.manifest.id} session discovery snapshot unavailable`,
            error,
          )
          void releaseDiscoveryLaunch()
          releaseDiscoveryLaunch = undefined
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
        effectiveCapabilities,
      }
      const spec =
        req.launchSpec ?? (resumed ? req.provider.resume(ctx) : req.provider.launch(ctx))
      const launch = spec.shellEnvironment
        ? interactiveShellLaunch(defaultShell, spec.file, spec.args)
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
      throw error
    } finally {
      if (this.pendingIds.get(sessionId)?.token === pending.token) {
        this.pendingIds.delete(sessionId)
      }
    }

    if (pending.cancelled || this.generation !== generation) {
      pty.kill()
      throw new Error(`PTY session '${sessionId}' was cancelled before it started`)
    }

    const info: ManagedPty = {
      id: sessionId,
      ownerId: req.ownerId,
      ownerGeneration: req.ownerGeneration ?? 0,
      hostId: req.host.hostId,
      cwd: req.cwd,
      workspaceRoot: req.workspaceRoot ?? req.cwd,
      providerId: req.provider.manifest.id,
      capabilities: effectiveCapabilities,
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
      dataListeners: new Set(),
      exitListeners: new Set(),
      telemetryListeners: new Set(),
      disposers: [],
      replay: [],
      replayLength: 0,
      replayPending: true,
      telemetryStarted: false,
      identityDiscoveryActive: false,
      launchDiagnostic: '',
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
        try {
          for (const cb of entry.exitListeners) cb(exit)
          for (const cb of this.globalExitListeners) cb(entry.info, exit)
        } finally {
          for (const dispose of entry.disposers) void dispose()
          entry.dataListeners.clear()
          entry.exitListeners.clear()
          entry.telemetryListeners.clear()
          // The registry represents live sessions. Removing an exited entry
          // also permits a later deterministic resume with the same id.
          if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
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
    if (handlers.onTelemetry && entry.telemetry) {
      handlers.onTelemetry(entry.telemetry)
    }
    return () => {
      if (handlers.onData) entry.dataListeners.delete(handlers.onData)
      if (handlers.onExit) entry.exitListeners.delete(handlers.onExit)
      if (handlers.onTelemetry) entry.telemetryListeners.delete(handlers.onTelemetry)
    }
  }

  write(id: string, ownerId: number, data: string, ownerGeneration?: number): void {
    const entry = this.requireOwned(id, ownerId, ownerGeneration)
    entry.pty.write(data)
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
    return entry.info
  }

  list(): ManagedPty[] {
    return [...this.entries.values()].map((e) => e.info)
  }

  isOwnedBy(id: string, ownerId: number, ownerGeneration?: number): boolean {
    const info = this.entries.get(id)?.info
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
    this.clearLifetimeListeners()
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
    for (const pending of this.pendingIds.values()) pending.cancelled = true
    this.pendingIds.clear()
    const pendingExits: PendingPtyExit[] = []
    for (const entry of this.entries.values()) {
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
    return pendingExits
  }

  private clearLifetimeListeners(): void {
    this.globalExitListeners.clear()
    this.identityListeners.clear()
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
      this.pendingIds.delete(id)
    }
    for (const [id, entry] of this.entries) {
      if (
        entry.info.ownerId !== ownerId ||
        (ownerGeneration !== undefined && entry.info.ownerGeneration !== ownerGeneration)
      ) {
        continue
      }
      this.disposeEntry(id, entry)
    }
  }

  /** Cancel one pending/live session when its narrow renderer lease is revoked. */
  disposeSession(id: string, ownerId: number, ownerGeneration?: number): void {
    const pending = this.pendingIds.get(id)
    if (
      pending?.ownerId === ownerId &&
      (ownerGeneration === undefined || pending.ownerGeneration === ownerGeneration)
    ) {
      pending.cancelled = true
      this.pendingIds.delete(id)
    }
    const entry = this.entries.get(id)
    if (
      entry?.info.ownerId === ownerId &&
      (ownerGeneration === undefined || entry.info.ownerGeneration === ownerGeneration)
    ) {
      this.disposeEntry(id, entry)
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

  private disposeEntry(id: string, entry: Entry): void {
    for (const dispose of entry.disposers) void dispose()
    entry.dataListeners.clear()
    entry.exitListeners.clear()
    entry.telemetryListeners.clear()
    entry.replay.length = 0
    entry.replayLength = 0
    if (!entry.exited) entry.pty.kill()
    if (this.entries.get(id) === entry) this.entries.delete(id)
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
      entry.info =
        result.status === 'identified'
          ? {
              ...entry.info,
              harnessSessionId: result.sessionId,
              identityStatus: 'identified',
            }
          : { ...entry.info, identityStatus: result.status }
      if (result.status === 'identified') {
        entry.identityRetry = undefined
        this.startTelemetry(
          entry,
          host,
          provider,
          result.sessionId,
          artifact,
          result.sessionData,
        )
      } else if (result.status === 'ambiguous') {
        entry.identityRetry = undefined
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
  }

  private retryIdentityAfterInput(entry: Entry): void {
    const retry = entry.identityRetry
    if (
      !retry ||
      entry.identityDiscoveryActive ||
      entry.exited ||
      entry.info.identityStatus === 'identified' ||
      this.entries.get(entry.info.id) !== entry
    ) {
      return
    }
    entry.identityDiscoveryActive = true
    entry.info = { ...entry.info, identityStatus: 'discovering' }
    for (const cb of this.identityListeners) cb(entry.info)

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
}

function interactiveShellLaunch(
  shell: string,
  file: string,
  args: readonly string[],
): { file: string; args: readonly string[] } {
  const command = [file, ...args].map(shellQuote).join(' ')
  return { file: shell, args: ['-ic', `exec ${command}`] }
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
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
