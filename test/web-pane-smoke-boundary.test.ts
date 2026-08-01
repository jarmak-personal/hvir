import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { once } from 'node:events'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import {
  closeWebPaneSmokeServer,
  withWebPaneDiagnosisTimeout,
  withWebPaneSmokeTimeout,
} from '../src/main/smoke/web-pane-boundary'

describe('web-pane smoke boundaries', () => {
  it('fails a never-settling operation at its named inner boundary', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const operation = withWebPaneSmokeTimeout(
      new Promise<never>(() => undefined),
      'web-pane-guest-ready-awaiting timed out',
      25,
    )
    const failure = expect(operation).rejects.toThrow(
      'web-pane-guest-ready-awaiting timed out',
    )

    await vi.advanceTimersByTimeAsync(25)

    await failure
  })

  it('bounds failure diagnosis independently of the failed operation', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const diagnosis = withWebPaneDiagnosisTimeout(new Promise<never>(() => undefined))
    const failure = expect(diagnosis).rejects.toThrow(
      'web pane failure diagnosis timed out',
    )

    await vi.advanceTimersByTimeAsync(1_000)

    await failure
  })

  it('force-closes a lingering dashboard connection during teardown', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    onTestFinished(() => {
      server.closeAllConnections()
      server.close()
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server port')
    const client = createConnection({ host: '127.0.0.1', port: address.port })
    onTestFinished(() => {
      client.destroy()
    })
    await once(client, 'connect')
    client.write('GET /never-finished HTTP/1.1\r\nHost: 127.0.0.1\r\n')

    await closeWebPaneSmokeServer(server)

    expect(server.listening).toBe(false)
  })
})
