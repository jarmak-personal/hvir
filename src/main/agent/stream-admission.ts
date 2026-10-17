import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  AGENT_LIMITS,
  agentFailure,
  validateAgentRequest,
  type AgentRequest,
  type AgentResponse,
} from '../../shared/agent/contract'
import type { HostId } from '../../shared/host-path'

export type AgentOrigin =
  | { readonly origin: 'application-local' }
  | {
      readonly origin: 'ssh-forward'
      readonly host: HostId
      readonly generation: string
      readonly lifetime?: AbortSignal
      readonly current: () => void
    }
export type AgentConnection = AgentOrigin & {
  readonly id: string
  readonly signal: AbortSignal
}

/** One framing, rate and resource authority for local and forwarded streams. */
export class AgentStreamAdmission {
  private readonly connections = new Set<Duplex>()
  private requests = 0
  private rate = { start: Date.now(), count: 0 }
  private disposed = false
  constructor(
    private readonly dispatch: (
      request: AgentRequest,
      connection: AgentConnection,
    ) => Promise<AgentResponse>,
  ) {}
  accept(socket: Duplex, origin: AgentOrigin, signal?: AbortSignal): void {
    if (this.disposed || this.connections.size >= AGENT_LIMITS.connections) {
      socket.destroy()
      return
    }
    this.connections.add(socket)
    const lifetime = new AbortController()
    const connection: AgentConnection = Object.freeze({
      id: randomUUID(),
      ...origin,
      signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
    })
    const buffer = Buffer.allocUnsafe(AGENT_LIMITS.frameBytes)
    let length = 0,
      admitted = false
    // The deadline is absolute, including fragmented frame admission.
    const timer = setTimeout(() => socket.destroy(), AGENT_LIMITS.deadlineMs)
    const cancelled = (): void => {
      lifetime.abort()
      socket.destroy()
    }
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      signal?.removeEventListener('abort', cancelled)
      clearTimeout(timer)
      lifetime.abort()
      this.connections.delete(socket)
    })
    socket.on('data', (chunk: Buffer) => {
      if (admitted || length + chunk.length > AGENT_LIMITS.frameBytes) {
        lifetime.abort()
        socket.destroy()
        return
      }
      const newline = chunk.indexOf(10)
      if (newline >= 0 && newline !== chunk.length - 1) {
        socket.destroy()
        return
      }
      chunk.copy(buffer, length, 0, newline < 0 ? chunk.length : newline)
      length += newline < 0 ? chunk.length : newline
      if (newline < 0) return
      admitted = true
      if (Date.now() - this.rate.start >= 1000)
        this.rate = { start: Date.now(), count: 0 }
      if (
        ++this.rate.count > AGENT_LIMITS.requestsPerSecond ||
        this.requests >= AGENT_LIMITS.requests
      ) {
        socket.destroy()
        return
      }
      let request: AgentRequest
      try {
        request = validateAgentRequest(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
          ),
        )
      } catch {
        socket.end(
          `${JSON.stringify(agentFailure('invalid-request', 'Invalid command frame; agent contract 1.0 is required', 64))}\n`,
        )
        return
      }
      this.requests++
      void this.dispatch(request, connection)
        .catch((reason: unknown) =>
          agentFailure(
            'unavailable',
            reason instanceof Error ? reason.message : 'Agent operation unavailable',
          ),
        )
        .then((response) => {
          const data = `${JSON.stringify(response)}\n`
          if (Buffer.byteLength(data) > AGENT_LIMITS.frameBytes) {
            socket.destroy()
            return
          }
          if (!socket.destroyed) socket.end(data)
        })
        .finally(() => {
          this.requests--
        })
    })
  }

  dispose(): void {
    this.disposed = true
    for (const stream of this.connections) stream.destroy()
  }
}
