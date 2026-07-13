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
import type { HarnessAdapter } from '../harness/harness-adapter'

export interface PtySpawnRequest {
  readonly host: ProjectHost
  readonly adapter: HarnessAdapter
  readonly cwd: HostPath
  /** Electron webContents id that owns and may control this PTY. */
  readonly ownerId: number
  /** Pre-assigned session id; generated if omitted (ADR-006 determinism). */
  readonly sessionId?: string
  /** Resume the session id via the adapter rather than launching fresh. */
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
}

export interface PtyStreamHandlers {
  onData?: (data: string) => void
  onExit?: (exit: PtyExit) => void
}

interface Entry {
  readonly info: ManagedPty
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
    let pty: PtyProcess
    try {
      const defaultShell = await req.host.defaultShell()
      const ctx = {
        sessionId,
        cwd: req.cwd,
        cols: req.cols,
        rows: req.rows,
        defaultShell,
      }
      const spec = resumed ? req.adapter.resume(ctx) : req.adapter.launch(ctx)
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
      hostId: req.host.hostId,
      adapterId: req.adapter.id,
      pid: pty.pid,
      startedAt: Date.now(),
      resumed,
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
          for (const cb of this.globalExitListeners) cb(info, exit)
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

  /** Kill every session and release listeners. */
  disposeAll(): void {
    this.generation++
    for (const pending of this.pendingIds.values()) pending.cancelled = true
    this.pendingIds.clear()
    for (const entry of this.entries.values()) {
      for (const dispose of entry.disposers) void dispose()
      if (!entry.exited) entry.pty.kill()
    }
    this.entries.clear()
    this.globalExitListeners.clear()
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
