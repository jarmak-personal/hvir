import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { LocalAgentEndpoint } from '../project-host/local-agent-endpoint'
import {
  AGENT_LIMITS,
  agentFailure,
  validateAgentRequest,
  type AgentRequest,
  type AgentResponse,
} from '../../shared/agent/contract'

export interface AgentConnection {
  readonly id: string
  /** Trusted adapter provenance. Wire fields and nonsecret terminal metadata cannot supply it. */
  readonly origin: 'application-local'
  readonly signal: AbortSignal
}
/** Bounded framing and physical socket ownership; all command policy belongs to its port. */
export class LocalAgentSocketServer {
  private server?: Server
  private readonly endpoint = new LocalAgentEndpoint()
  private readonly connections = new Set<Socket>()
  private requests = 0
  private rate = { start: Date.now(), count: 0 }
  private disposed = false
  private starting?: Promise<string>
  private stopping?: Promise<void>
  constructor(
    private readonly dispatch: (
      request: AgentRequest,
      connection: AgentConnection,
    ) => Promise<AgentResponse>,
  ) {}
  start(instance: string): Promise<string> {
    return (this.starting ??= this.initialize(instance))
  }
  private async initialize(instance: string): Promise<string> {
    const endpoint = await this.endpoint.prepare(instance)
    if (this.disposed) throw new Error('Agent endpoint has ended')
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const failure = (reason: Error): void => reject(reason)
      server.once('error', failure)
      server.listen(endpoint, () => {
        server.off('error', failure)
        resolve()
      })
    })
    server.on('error', () => {
      void this.dispose()
    })
    try {
      await this.endpoint.claim()
      if (this.disposed) {
        await this.closeServer()
        throw new Error('Agent endpoint has ended')
      }
      return endpoint
    } catch (reason) {
      await this.closeServer()
      throw reason
    }
  }
  private accept(socket: Socket): void {
    if (this.disposed || this.connections.size >= AGENT_LIMITS.connections) {
      socket.destroy()
      return
    }
    this.connections.add(socket)
    const lifetime = new AbortController()
    const connection: AgentConnection = Object.freeze({
      id: randomUUID(),
      origin: 'application-local',
      signal: lifetime.signal,
    })
    const buffer = Buffer.allocUnsafe(AGENT_LIMITS.frameBytes)
    let length = 0,
      admitted = false
    // The deadline is absolute, including fragmented frame admission.
    const timer = setTimeout(() => socket.destroy(), AGENT_LIMITS.deadlineMs)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
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

  dispose(): Promise<void> {
    this.disposed = true
    for (const socket of this.connections) socket.destroy()
    return (this.stopping ??= Promise.resolve(this.starting)
      .catch(() => undefined)
      .then(() => this.closeServer()))
  }
  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server?.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    await this.endpoint.release()
  }
}
