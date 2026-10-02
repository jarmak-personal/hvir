import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  LocalAgentSocketServer,
  type AgentConnection,
} from '../src/main/agent/socket-server'
import {
  AGENT_CONTRACT,
  agentOutput,
  type AgentRequest,
} from '../src/shared/agent/contract'
const request = {
  contract: AGENT_CONTRACT,
  argv: ['workspaces'],
  stdin: '',
  defaults: {},
}
function exchange(endpoint: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let response = ''
    socket.setTimeout(2000, () => socket.destroy(new Error('Timed out')))
    socket.once('connect', () => socket.write(frame))
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })
    socket.once('error', reject)
    socket.once('end', () => resolve(response))
  })
}
describe('real private agent socket', () => {
  it('frames actual commands, refuses malformed contracts and releases the exact endpoint', async () => {
    const dispatch = vi.fn((_request: AgentRequest, connection: AgentConnection) =>
      Promise.resolve(agentOutput({ origin: connection.origin })),
    )
    const server = new LocalAgentSocketServer(dispatch),
      endpoint = await server.start(randomUUID())
    try {
      expect((await lstat(endpoint)).mode & 0o777).toBe(0o600)
      expect(Buffer.byteLength(endpoint)).toBeLessThan(104)
      const response = JSON.parse(
        await exchange(
          endpoint,
          `${JSON.stringify({ ...request, origin: 'forwarded' })}\n`,
        ),
      ) as { stdout: string }
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: true,
        origin: 'application-local',
      })
      expect(dispatch).toHaveBeenCalledTimes(1)
      const invalid = JSON.parse(await exchange(endpoint, '{broken}\n')) as {
        exitStatus: number
      }
      expect(invalid.exitStatus).toBe(64)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      await server.dispose()
    }
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cancels admitted work on caller disconnect and application exit', async () => {
    let connection!: AgentConnection
    const server = new LocalAgentSocketServer(async (_request, admitted) => {
      connection = admitted
      await new Promise<void>((resolve) =>
        admitted.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return agentOutput({ ended: true })
    })
    const endpoint = await server.start(randomUUID()),
      socket = createConnection(endpoint)
    try {
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
      await vi.waitFor(() => expect(connection).toBeDefined())
      socket.destroy()
      await vi.waitFor(() => expect(connection.signal.aborted).toBe(true))
    } finally {
      socket.destroy()
      await server.dispose()
    }
  })
})
