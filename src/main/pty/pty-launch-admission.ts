import {
  TerminalStartAdmission,
  hostPathEquals,
  type HostId,
  type HostPath,
} from '../../shared'
import type { Disposer } from '../project-host/project-host'

interface PendingOwner {
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly workspaceRoot: HostPath
}

/** A reservation can only be revoked by its admission owner. */
export interface PtyLaunchReservation {
  readonly signal: AbortSignal
  readonly cancelled: boolean
  assertCurrent(): void
  release(): void
}

/** Owns pending starts and launch ordering, never live PTY authority. */
export class PtyLaunchAdmission {
  private readonly pending = new Map<
    string,
    PendingOwner & { controller: AbortController }
  >()
  private readonly discoveryQueues = new Map<string, Promise<void>>()
  private readonly bulk: TerminalStartAdmission

  constructor(concurrency: number) {
    this.bulk = new TerminalStartAdmission(concurrency)
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  reserve(id: string, owner: PendingOwner): PtyLaunchReservation {
    const pending = { ...owner, controller: new AbortController() }
    this.pending.set(id, pending)
    return {
      signal: pending.controller.signal,
      get cancelled() {
        return pending.controller.signal.aborted
      },
      assertCurrent: () => {
        if (pending.controller.signal.aborted) {
          throw new Error(`PTY session '${id}' was cancelled before it started`)
        }
      },
      release: () => {
        if (this.pending.get(id) === pending) this.pending.delete(id)
      },
    }
  }

  acquireBulk(hostId: HostId, signal: AbortSignal): Promise<Disposer> {
    return this.bulk.acquire(hostId, signal)
  }

  reserveDiscoveryLaunch(key: string): Promise<Disposer> {
    const previous = this.discoveryQueues.get(key) ?? Promise.resolve()
    let openGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    // Reserve before awaiting; post-launch discovery never holds this gate.
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
            if (this.discoveryQueues.get(key) === tail) this.discoveryQueues.delete(key)
          })
        }
      })
  }

  isOwnedBy(id: string, ownerId: number, generation?: number): boolean {
    const pending = this.pending.get(id)
    return (
      pending?.ownerId === ownerId &&
      (generation === undefined || pending.ownerGeneration === generation)
    )
  }

  cancelSession(id: string, ownerId: number, generation?: number): boolean {
    if (!this.isOwnedBy(id, ownerId, generation)) return false
    this.cancel(id)
    return true
  }

  workspaceSessionIds(root: HostPath): string[] {
    return [...this.pending]
      .filter(([, p]) => hostPathEquals(p.workspaceRoot, root))
      .map(([id]) => id)
  }

  cancelWorkspace(root: HostPath): void {
    for (const id of this.workspaceSessionIds(root)) this.cancel(id)
  }

  cancelOwner(ownerId: number, generation?: number): void {
    for (const id of this.pending.keys()) this.cancelSession(id, ownerId, generation)
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.cancel(id)
  }

  private cancel(id: string): void {
    this.pending.get(id)?.controller.abort()
    this.pending.delete(id)
  }
}
