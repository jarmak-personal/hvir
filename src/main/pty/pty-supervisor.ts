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

import type { HostId, HostPath } from '../../shared'
import type { Disposer, ProjectHost, PtyExit, PtyProcess } from '../project-host'
import type { HarnessAdapter, HarnessSessionDiscovery } from '../harness/harness-adapter'

export interface PtySpawnRequest {
  readonly host: ProjectHost
  readonly adapter: HarnessAdapter
  readonly cwd: HostPath
  /** Electron webContents id that owns and may control this PTY. */
  readonly ownerId: number
  /** hvir's PTY registry id; generated if omitted. */
  readonly sessionId?: string
  /** Exact harness-owned session id, when distinct from the PTY id. */
  readonly harnessSessionId?: string
  /** Resume `harnessSessionId` via the adapter rather than launching fresh. */
  readonly resume?: boolean
  readonly cols?: number
  readonly rows?: number
}

/** Immutable, serializable description of a managed PTY session. */
export interface ManagedPty {
  readonly id: string
  readonly ownerId: number
  readonly hostId: HostId
  readonly adapterId: string
  readonly pid: number
  readonly startedAt: number
  readonly resumed: boolean
  readonly harnessSessionId?: string
  readonly identityStatus: HarnessSessionIdentityStatus
}

export type HarnessSessionIdentityStatus =
  'none' | 'discovering' | 'identified' | 'ambiguous' | 'unavailable'

export interface PtyStreamHandlers {
  onData?: (data: string) => void
  onExit?: (exit: PtyExit) => void
}

interface Entry {
  info: ManagedPty
  readonly pty: PtyProcess
  readonly dataListeners: Set<(data: string) => void>
  readonly exitListeners: Set<(exit: PtyExit) => void>
  readonly disposers: Disposer[]
  readonly replay: string[]
  replayLength: number
  replayPending: boolean
  exited: boolean
}

interface PendingEntry {
  readonly token: symbol
  readonly ownerId: number
  cancelled: boolean
}

const MAX_INITIAL_REPLAY_LENGTH = 256 * 1024

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
      cancelled: false,
    }
    const generation = this.generation
    this.pendingIds.set(sessionId, pending)

    const resumed = req.resume === true && req.adapter.supportsResume
    const harnessSessionId = resumed
      ? (req.harnessSessionId ??
        (req.adapter.sessionIdentity === 'preassigned' ? sessionId : undefined))
      : req.adapter.sessionIdentity === 'preassigned'
        ? sessionId
        : undefined
    if (resumed && !harnessSessionId) {
      this.pendingIds.delete(sessionId)
      throw new Error(`Harness '${req.adapter.id}' resume requires an exact session id`)
    }

    const discovery =
      !resumed && req.adapter.sessionIdentity === 'discovered'
        ? req.adapter.sessionDiscovery
        : undefined
    let discoverySnapshot: unknown
    let discoveryReady = false
    let releaseDiscovery: Disposer | undefined
    let pty: PtyProcess
    let launchedAtMs = Date.now()
    try {
      if (discovery) {
        releaseDiscovery = await this.reserveDiscovery(
          `${req.host.hostId}:${req.adapter.id}`,
        )
        this.assertPending(sessionId, pending, generation)
        try {
          discoverySnapshot = await discovery.snapshot(req.host)
          discoveryReady = true
        } catch (error) {
          console.warn(
            `[pty] ${req.adapter.id} session discovery snapshot unavailable`,
            error,
          )
          void releaseDiscovery()
          releaseDiscovery = undefined
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
      }
      const spec = resumed ? req.adapter.resume(ctx) : req.adapter.launch(ctx)
      launchedAtMs = Date.now()
      pty = await req.host.spawnPty({
        file: spec.file,
        args: spec.args,
        cwd: req.cwd,
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
          ...spec.env,
        },
        cols: req.cols,
        rows: req.rows,
      })
    } catch (error) {
      void releaseDiscovery?.()
      throw error
    } finally {
      if (this.pendingIds.get(sessionId)?.token === pending.token) {
        this.pendingIds.delete(sessionId)
      }
    }

    if (pending.cancelled || this.generation !== generation) {
      void releaseDiscovery?.()
      pty.kill()
      throw new Error(`PTY session '${sessionId}' was cancelled before it started`)
    }

    const info: ManagedPty = {
      id: sessionId,
      ownerId: req.ownerId,
      hostId: req.host.hostId,
      adapterId: req.adapter.id,
      pid: pty.pid,
      startedAt: launchedAtMs,
      resumed,
      harnessSessionId,
      identityStatus: identityStatus(req.adapter, harnessSessionId, discoveryReady),
    }

    const entry: Entry = {
      info,
      pty,
      dataListeners: new Set(),
      exitListeners: new Set(),
      disposers: [],
      replay: [],
      replayLength: 0,
      replayPending: true,
      exited: false,
    }

    // Publish before subscribing so even a host implementation that reports an
    // already-finished PTY synchronously can remove the right registry entry.
    this.entries.set(sessionId, entry)

    entry.disposers.push(
      pty.onData((data) => {
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
        try {
          for (const cb of entry.exitListeners) cb(exit)
          for (const cb of this.globalExitListeners) cb(entry.info, exit)
        } finally {
          for (const dispose of entry.disposers) void dispose()
          entry.dataListeners.clear()
          entry.exitListeners.clear()
          // The registry represents live sessions. Removing an exited entry
          // also permits a later deterministic resume with the same id.
          if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
        }
      }),
    )

    if (discovery && discoveryReady && releaseDiscovery) {
      const controller = new AbortController()
      this.discoveryControllers.add(controller)
      void this.identifySession(
        entry,
        req.host,
        discovery,
        discoverySnapshot,
        req.cwd,
        launchedAtMs,
        controller,
        releaseDiscovery,
      )
    }

    return info
  }

  /** Attach renderer stream handlers. Returns a disposer that detaches them. */
  attach(id: string, ownerId: number, handlers: PtyStreamHandlers): Disposer {
    const entry = this.requireOwned(id, ownerId)
    if (handlers.onData) entry.dataListeners.add(handlers.onData)
    if (handlers.onExit) entry.exitListeners.add(handlers.onExit)
    if (handlers.onData && entry.replayPending) {
      entry.replayPending = false
      const replay = entry.replay.splice(0)
      entry.replayLength = 0
      for (const data of replay) handlers.onData(data)
    }
    return () => {
      if (handlers.onData) entry.dataListeners.delete(handlers.onData)
      if (handlers.onExit) entry.exitListeners.delete(handlers.onExit)
    }
  }

  write(id: string, ownerId: number, data: string): void {
    this.requireOwned(id, ownerId).pty.write(data)
  }

  resize(id: string, ownerId: number, cols: number, rows: number): void {
    this.requireOwned(id, ownerId).pty.resize(cols, rows)
  }

  kill(id: string, ownerId: number, signal?: string): void {
    this.requireOwned(id, ownerId).pty.kill(signal)
  }

  get(id: string): ManagedPty | undefined {
    return this.entries.get(id)?.info
  }

  list(): ManagedPty[] {
    return [...this.entries.values()].map((e) => e.info)
  }

  isOwnedBy(id: string, ownerId: number): boolean {
    return this.entries.get(id)?.info.ownerId === ownerId
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

  /** Kill every session and release listeners. */
  disposeAll(): void {
    this.generation++
    for (const controller of this.discoveryControllers) controller.abort()
    this.discoveryControllers.clear()
    for (const pending of this.pendingIds.values()) pending.cancelled = true
    this.pendingIds.clear()
    for (const entry of this.entries.values()) {
      for (const dispose of entry.disposers) void dispose()
      if (!entry.exited) entry.pty.kill()
    }
    this.entries.clear()
    this.globalExitListeners.clear()
    this.identityListeners.clear()
  }

  /** Kill only the sessions and pending spawns owned by one renderer. */
  disposeOwner(ownerId: number): void {
    for (const [id, pending] of this.pendingIds) {
      if (pending.ownerId !== ownerId) continue
      pending.cancelled = true
      this.pendingIds.delete(id)
    }
    for (const [id, entry] of this.entries) {
      if (entry.info.ownerId !== ownerId) continue
      for (const dispose of entry.disposers) void dispose()
      entry.dataListeners.clear()
      entry.exitListeners.clear()
      entry.replay.length = 0
      entry.replayLength = 0
      if (!entry.exited) entry.pty.kill()
      this.entries.delete(id)
    }
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`No PTY session '${id}'`)
    return entry
  }

  private requireOwned(id: string, ownerId: number): Entry {
    const entry = this.require(id)
    if (entry.info.ownerId !== ownerId) {
      throw new Error(`PTY session '${id}' belongs to another renderer`)
    }
    return entry
  }

  private assertPending(id: string, pending: PendingEntry, generation: number): void {
    if (pending.cancelled || this.generation !== generation) {
      throw new Error(`PTY session '${id}' was cancelled before it started`)
    }
  }

  private reserveDiscovery(key: string): Promise<Disposer> {
    const previous = this.discoveryQueues.get(key) ?? Promise.resolve()
    let openGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    // Store the reservation before awaiting the previous holder. Concurrent
    // spawn() calls therefore cannot capture the same persisted-session baseline.
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
    discovery: HarnessSessionDiscovery,
    snapshot: unknown,
    cwd: HostPath,
    launchedAtMs: number,
    controller: AbortController,
    release: Disposer,
  ): Promise<void> {
    try {
      const result = await discovery.identify(host, snapshot, {
        cwd,
        launchedAtMs,
        signal: controller.signal,
      })
      entry.info =
        result.status === 'identified'
          ? {
              ...entry.info,
              harnessSessionId: result.sessionId,
              identityStatus: 'identified',
            }
          : { ...entry.info, identityStatus: result.status }
    } catch (error) {
      entry.info = { ...entry.info, identityStatus: 'unavailable' }
      if (!controller.signal.aborted) {
        console.warn(`[pty] ${entry.info.adapterId} session discovery unavailable`, error)
      }
    } finally {
      this.discoveryControllers.delete(controller)
      void release()
    }
    for (const cb of this.identityListeners) cb(entry.info)
  }
}

function identityStatus(
  adapter: HarnessAdapter,
  harnessSessionId: string | undefined,
  discoveryReady: boolean,
): HarnessSessionIdentityStatus {
  if (adapter.sessionIdentity === 'none') return 'none'
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
