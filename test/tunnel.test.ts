import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'

import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { SshHost } from '../src/main/project-host/ssh-host'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}

type EchoChannel = PassThrough & { close: () => void }

function echoChannel(): EchoChannel {
  const channel = Object.assign(new PassThrough(), {
    close: (): void => {
      channel.destroy()
    },
  })
  return channel
}

function fakeForwardClient(
  forwardOut: ReturnType<typeof vi.fn>,
): EventEmitter & { forwardOut: ReturnType<typeof vi.fn> } {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(() => queueMicrotask(() => client.emit('ready'))),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
    forwardOut,
  })
  return client
}

/**
 * A connected host whose primary (control) transport is `client`. Tunnel data
 * connections grow a dedicated tunnel transport, so `clientFactory` supplies
 * another fake carrying the same `forwardOut` spy.
 */
function connectedHost(
  client: EventEmitter & { forwardOut: ReturnType<typeof vi.fn> },
): SshHost {
  const host = new SshHost({
    config: aliasConfig(),
    prompter: { prompt: () => Promise.resolve(undefined) },
    clientFactory: () => fakeForwardClient(client.forwardOut) as unknown as Client,
  })
  const internals = host as unknown as { state: string; client: Client }
  internals.state = 'connected'
  internals.client = client as unknown as Client
  return host
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let received = ''
    socket.on('data', (chunk) => {
      received += String(chunk)
      if (received.length >= payload.length) socket.end()
    })
    socket.on('close', () => resolve(received))
    socket.on('error', reject)
    socket.write(payload)
  })
}

describe('SshHost tunnels', () => {
  it('forwards local TCP connections through direct-tcpip channels', async () => {
    const forwardOut = vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (error: Error | undefined, channel: unknown) => void,
      ) => callback(undefined, echoChannel()),
    )
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    const tunnel = await host.forwardLocalPort(8501)
    await expect(roundTrip(tunnel.localPort, 'hello gas city')).resolves.toBe(
      'hello gas city',
    )
    expect(forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      '127.0.0.1',
      8501,
      expect.any(Function),
    )
    await tunnel.close()
  })

  it('serves concurrent connections through one tunnel', async () => {
    const forwardOut = vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (error: Error | undefined, channel: unknown) => void,
      ) => callback(undefined, echoChannel()),
    )
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    const tunnel = await host.forwardLocalPort(3000)
    const payloads = Array.from({ length: 8 }, (_, index) => `payload-${index}`)
    const replies = await Promise.all(
      payloads.map((payload) => roundTrip(tunnel.localPort, payload)),
    )
    expect(replies).toEqual(payloads)
    await tunnel.close()
  })

  it('stops accepting connections once the tunnel closes', async () => {
    const forwardOut = vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (error: Error | undefined, channel: unknown) => void,
      ) => callback(undefined, echoChannel()),
    )
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    const tunnel = await host.forwardLocalPort(3000)
    const { localPort } = tunnel
    await tunnel.close()
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: localPort })
        socket.on('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.on('error', reject)
      }),
    ).rejects.toThrow()
  })

  it('destroys forwarded sockets when the remote channel refuses', async () => {
    const forwardOut = vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (error: Error | undefined, channel: unknown) => void,
      ) =>
        callback(new Error('(SSH) Channel open failure: Connection refused'), undefined),
    )
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    const tunnel = await host.forwardLocalPort(3000)
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: tunnel.localPort })
        socket.on('data', () => reject(new Error('Expected no data')))
        socket.on('close', () => resolve('closed'))
        socket.on('error', () => undefined)
      }),
    ).resolves.toBe('closed')
    await tunnel.close()
  })

  it('rejects invalid ports before touching the transport', async () => {
    const host = connectedHost(fakeForwardClient(vi.fn()))
    cleanups.push(() => host.dispose())

    await expect(host.forwardLocalPort(0)).rejects.toThrow('Invalid tunnel port')
    await expect(host.forwardLocalPort(65_536)).rejects.toThrow('Invalid tunnel port')
  })
})

describe('LocalHost tunnels', () => {
  it('identity-forwards loopback ports', async () => {
    const host = new LocalHost()
    const tunnel = await host.forwardLocalPort(8501)
    expect(tunnel.localPort).toBe(8501)
    await tunnel.close()
  })
})

describe('web pane guest URL policy', () => {
  it('admits only loopback http URLs', async () => {
    const { isLoopbackHttpUrl } = await import('../src/main/navigation-policy')
    expect(isLoopbackHttpUrl('http://127.0.0.1:8082/')).toBe(true)
    expect(isLoopbackHttpUrl('http://127.0.0.1:5174/dash?tab=1')).toBe(true)
    expect(isLoopbackHttpUrl('http://localhost:8082/')).toBe(false)
    expect(isLoopbackHttpUrl('https://127.0.0.1:8082/')).toBe(false)
    expect(isLoopbackHttpUrl('http://100.122.69.12:8082/')).toBe(false)
    expect(isLoopbackHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackHttpUrl('not a url')).toBe(false)
  })
})
