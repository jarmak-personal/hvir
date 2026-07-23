export type TerminalStartAdmissionRelease = () => void

interface PendingAdmission {
  readonly signal: AbortSignal
  readonly resolve: (release: TerminalStartAdmissionRelease) => void
  readonly reject: (reason: Error) => void
  readonly abort: () => void
}

interface HostAdmissions {
  active: number
  readonly pending: PendingAdmission[]
}

/** Bounds explicitly requested bulk terminal starts independently for each host. */
export class TerminalStartAdmission {
  private readonly hosts = new Map<string, HostAdmissions>()

  constructor(private readonly perHostLimit = 2) {
    if (!Number.isSafeInteger(perHostLimit) || perHostLimit < 1) {
      throw new Error('Terminal start admission limit must be a positive integer')
    }
  }

  acquire(
    hostId: string,
    signal: AbortSignal,
  ): Promise<TerminalStartAdmissionRelease> {
    if (signal.aborted) return Promise.reject(cancelled())
    const host = this.hosts.get(hostId) ?? { active: 0, pending: [] }
    this.hosts.set(hostId, host)
    if (host.active < this.perHostLimit) {
      host.active++
      return Promise.resolve(this.release(hostId, host))
    }

    return new Promise<TerminalStartAdmissionRelease>((resolve, reject) => {
      const pending: PendingAdmission = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = host.pending.indexOf(pending)
          if (index >= 0) host.pending.splice(index, 1)
          signal.removeEventListener('abort', pending.abort)
          reject(cancelled())
          this.deleteIdleHost(hostId, host)
        },
      }
      host.pending.push(pending)
      signal.addEventListener('abort', pending.abort, { once: true })
    })
  }

  private release(
    hostId: string,
    host: HostAdmissions,
  ): TerminalStartAdmissionRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      host.active--
      this.admitPending(hostId, host)
    }
  }

  private admitPending(hostId: string, host: HostAdmissions): void {
    while (host.active < this.perHostLimit && host.pending.length > 0) {
      const pending = host.pending.shift()!
      pending.signal.removeEventListener('abort', pending.abort)
      if (pending.signal.aborted) {
        pending.reject(cancelled())
        continue
      }
      host.active++
      pending.resolve(this.release(hostId, host))
    }
    this.deleteIdleHost(hostId, host)
  }

  private deleteIdleHost(hostId: string, host: HostAdmissions): void {
    if (host.active === 0 && host.pending.length === 0) {
      this.hosts.delete(hostId)
    }
  }
}

function cancelled(): Error {
  return new Error('Terminal start admission was cancelled')
}
