import { randomUUID } from 'node:crypto'
import type { Client, Channel } from 'ssh2'
import type { Duplex } from 'node:stream'
import type { HostId, HostPath } from '../../shared/host-path'
import {
  StreamLocalForwardUnusedError,
  type StreamLocalBinding,
  type StreamLocalForward,
} from './project-host'
import type { SshTransportPool } from './ssh-transport-pool'

/** Immediate forwarding mechanics, revoked by SshHost before replacing its authenticated client. */
export class SshStreamLocalOwner {
  private readonly identity = randomUUID()
  private readonly pending = new Map<
    Client,
    { requests: Set<symbol>; close(this: void): void }
  >()
  private generation = new AbortController()
  private readonly forwards = new Set<StreamLocalForward>()
  constructor(private readonly pool: SshTransportPool) {}
  private physicalRequest(client: Client): () => boolean {
    let entry = this.pending.get(client)
    if (!entry) {
      entry = { requests: new Set(), close: () => this.pending.delete(client) }
      this.pending.set(client, entry)
      client.once('close', entry.close)
    }
    const token = Symbol(),
      owned = entry
    owned.requests.add(token)
    return () => {
      if (!owned.requests.delete(token)) return false
      if (!owned.requests.size && this.pending.get(client) === owned) {
        client.off('close', owned.close)
        this.pending.delete(client)
      }
      return true
    }
  }
  revoke(): void {
    this.generation.abort()
    for (const forward of this.forwards) void forward.dispose().catch(() => undefined)
    this.generation = new AbortController()
  }
  binding(
    host: HostId,
    generation: number,
    client: Client,
    current: () => boolean,
  ): StreamLocalBinding {
    const signal = this.generation.signal
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      if (!current()) throw new Error('SSH agent connection was replaced or disconnected')
    }
    return Object.freeze({
      host,
      generation: `${this.identity}:${generation}`,
      signal,
      assertCurrent,
      forward: async (path: HostPath, admitted: (stream: Duplex) => void) => {
        try {
          assertCurrent()
        } catch {
          throw new StreamLocalForwardUnusedError(
            'SSH agent connection is no longer available',
          )
        }
        if (
          path.hostId !== host ||
          !path.path.startsWith('/') ||
          path.path.includes('\0') ||
          Buffer.byteLength(path.path) >= 104
        )
          throw new StreamLocalForwardUnusedError(
            'SSH agent socket path is unsafe or too long',
          )
        if (this.pending.has(client))
          throw new StreamLocalForwardUnusedError(
            'SSH agent setup is unavailable while earlier physical forwarding replies remain unanswered',
          )
        const controller = new AbortController(),
          streams = new Set<Channel>()
        let stopping: Promise<void> | undefined,
          ready = false
        const unforward = (): Promise<void> =>
          new Promise((resolve, reject) => {
            if (!current()) {
              resolve()
              return
            }
            const timer = setTimeout(
              () => reject(new Error('SSH agent socket cleanup timed out')),
              8000,
            )
            const answered = this.physicalRequest(client)
            try {
              client.openssh_unforwardInStreamLocal(path.path, (error) => {
                if (!answered()) return
                clearTimeout(timer)
                if (error) reject(new Error('SSH agent socket cleanup failed'))
                else resolve()
              })
            } catch {
              answered()
              clearTimeout(timer)
              reject(new Error('SSH agent socket cleanup unavailable'))
            }
          })
        const dispose = (): Promise<void> => {
          if (stopping) return stopping
          controller.abort()
          ready = false
          client.off('unix connection', incoming)
          this.forwards.delete(forward)
          const closed = Promise.all(
            [...streams].map(
              (stream) =>
                new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    stream.off('close', complete)
                    reject(
                      new Error(
                        'SSH agent clients have not physically closed; cache lease retained',
                      ),
                    )
                  }, 8000)
                  const complete = (): void => {
                    clearTimeout(timer)
                    resolve()
                  }
                  stream.once('close', complete)
                  try {
                    stream.close()
                  } catch {
                    stream.destroy()
                  }
                }),
            ),
          )
          stopping = Promise.all([closed, unforward()]).then(() => undefined)
          return stopping
        }
        const incoming = (
          info: { socketPath: string },
          accept: () => Channel,
          reject: () => void,
        ): void => {
          if (info.socketPath !== path.path) return
          let stream: Channel | undefined
          try {
            if (!ready || signal.aborted || controller.signal.aborted || !current()) {
              reject()
              return
            }
            stream = this.pool.acceptIncoming(client, accept)
            if (!stream) {
              reject()
              return
            }
            streams.add(stream)
            stream.once('close', () => streams.delete(stream!))
            stream.on('error', () => stream?.destroy())
            admitted(stream)
          } catch {
            // EventEmitter callbacks must never leak adapter failure into Electron main.
            if (stream) stream.destroy()
            else {
              try {
                reject()
              } catch {
                /* Transport is already gone. */
              }
            }
          }
        }
        const forward: StreamLocalForward = { signal: controller.signal, dispose }
        client.on('unix connection', incoming)
        this.forwards.add(forward)
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: Error): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              signal.removeEventListener('abort', cancelled)
              if (error) reject(error)
              else resolve()
            }
            const cancelled = (): void =>
              finish(new Error('SSH agent forward was revoked'))
            const timer = setTimeout(
              () => finish(new Error('SSH agent forwarding timed out')),
              8000,
            )
            signal.addEventListener('abort', cancelled, { once: true })
            const answered = this.physicalRequest(client)
            try {
              client.openssh_forwardInStreamLocal(path.path, (error) => {
                if (!answered()) return
                if (!error && (settled || signal.aborted || controller.signal.aborted)) {
                  // A delayed successful reply can follow the earlier cancel request: cancel again.
                  void unforward().catch(() => undefined)
                  finish(new Error('SSH agent forward was revoked'))
                } else
                  finish(
                    error
                      ? new StreamLocalForwardUnusedError(
                          'This SSH host does not allow Unix socket forwarding',
                        )
                      : undefined,
                  )
              })
            } catch {
              answered()
              finish(new Error('This SSH host does not support Unix socket forwarding'))
            }
          })
          assertCurrent()
          ready = true
          return forward
        } catch (reason) {
          await dispose().catch(() => undefined)
          throw reason
        }
      },
    })
  }
}
