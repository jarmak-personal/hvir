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
  exited: boolean
}

export class PtySupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly pendingIds = new Map<string, symbol>()
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
    const pendingToken = Symbol(sessionId)
    const generation = this.generation
    this.pendingIds.set(sessionId, pendingToken)

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
      if (this.pendingIds.get(sessionId) === pendingToken) {
        this.pendingIds.delete(sessionId)
      }
    }

    if (this.generation !== generation) {
      pty.kill()
      throw new Error(`PTY session '${sessionId}' was cancelled before it started`)
    }

    const info: ManagedPty = {
      id: sessionId,
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
      exited: false,
    }

    // Publish before subscribing so even a host implementation that reports an
    // already-finished PTY synchronously can remove the right registry entry.
    this.entries.set(sessionId, entry)

    entry.disposers.push(
      pty.onData((data) => {
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
  attach(id: string, handlers: PtyStreamHandlers): Disposer {
    const entry = this.require(id)
    if (handlers.onData) entry.dataListeners.add(handlers.onData)
    if (handlers.onExit) entry.exitListeners.add(handlers.onExit)
    return () => {
      if (handlers.onData) entry.dataListeners.delete(handlers.onData)
      if (handlers.onExit) entry.exitListeners.delete(handlers.onExit)
    }
  }

  write(id: string, data: string): void {
    this.require(id).pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.require(id).pty.resize(cols, rows)
  }

  kill(id: string, signal?: string): void {
    this.require(id).pty.kill(signal)
  }

  get(id: string): ManagedPty | undefined {
    return this.entries.get(id)?.info
  }

  list(): ManagedPty[] {
    return [...this.entries.values()].map((e) => e.info)
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
    this.pendingIds.clear()
    for (const entry of this.entries.values()) {
      for (const dispose of entry.disposers) void dispose()
      if (!entry.exited) entry.pty.kill()
    }
    this.entries.clear()
    this.globalExitListeners.clear()
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`No PTY session '${id}'`)
    return entry
  }
}
