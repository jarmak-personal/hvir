import { createServer, type Server } from 'node:net'
import { LocalAgentEndpoint } from '../project-host/local-agent-endpoint'
import { AgentStreamAdmission, type AgentConnection } from './stream-admission'
import type { AgentRequest, AgentResponse } from '../../shared/agent/contract'
export type { AgentConnection } from './stream-admission'
/** Bounded framing and physical socket ownership; all command policy belongs to its port. */
export class LocalAgentSocketServer {
  private server?: Server
  private readonly endpoint = new LocalAgentEndpoint()
  private readonly admission: AgentStreamAdmission
  private readonly lifetime = new AbortController()
  private disposed = false
  private starting?: Promise<string>
  private stopping?: Promise<void>
  constructor(
    dispatch: (
      request: AgentRequest,
      connection: AgentConnection,
    ) => Promise<AgentResponse>,
    admission?: AgentStreamAdmission,
  ) {
    this.admission = admission ?? new AgentStreamAdmission(dispatch)
  }
  start(instance: string): Promise<string> {
    return (this.starting ??= this.initialize(instance))
  }
  private async initialize(instance: string): Promise<string> {
    const endpoint = await this.endpoint.prepare(instance)
    if (this.disposed) throw new Error('Agent endpoint has ended')
    const server = createServer((socket) =>
      this.admission.accept(
        socket,
        { origin: 'application-local' },
        this.lifetime.signal,
      ),
    )
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

  dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort()
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
