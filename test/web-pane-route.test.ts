import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as connectSocket, createServer as createTcpServer } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'

import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { SshHost } from '../src/main/project-host/ssh-host'
import { LoopbackHttpProxy } from '../src/main/web-pane/loopback-http-proxy'
import { asHostId, parseLoopbackHttpTarget } from '../src/shared'

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

function roundTrip(stream: Duplex, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = ''
    stream.on('data', (chunk) => {
      received += String(chunk)
      if (received.length >= payload.length) {
        stream.destroy()
        resolve(received)
      }
    })
    stream.on('error', reject)
    stream.write(payload)
  })
}

describe('ProjectHost loopback streams', () => {
  it('uses a dedicated SSH direct-tcpip channel for the exact endpoint', async () => {
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

    const stream = await host.connectLoopback({ hostname: 'localhost', port: 8501 })
    await expect(roundTrip(stream, 'hello gas city')).resolves.toBe('hello gas city')
    expect(forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'localhost',
      8501,
      expect.any(Function),
    )
  })

  it('surfaces remote channel refusal without creating a local listener', async () => {
    const forwardOut = vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (error: Error | undefined, channel?: unknown) => void,
      ) => callback(new Error('(SSH) Channel open failure: Connection refused')),
    )
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    await expect(
      host.connectLoopback({ hostname: '127.0.0.1', port: 3000 }),
    ).rejects.toThrow('Connection refused')
  })

  it('rejects invalid endpoint capabilities before touching SSH', async () => {
    const forwardOut = vi.fn()
    const host = connectedHost(fakeForwardClient(forwardOut))
    cleanups.push(() => host.dispose())

    await expect(
      host.connectLoopback({ hostname: '127.0.0.1', port: 0 }),
    ).rejects.toThrow('Invalid loopback endpoint')
    await expect(
      host.connectLoopback({ hostname: 'example.com' as 'localhost', port: 80 }),
    ).rejects.toThrow('Invalid loopback endpoint')
    expect(forwardOut).not.toHaveBeenCalled()
  })

  it('opens a direct local socket through the same seam', async () => {
    const server = createTcpServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')

    const stream = await new LocalHost().connectLoopback({
      hostname: '127.0.0.1',
      port: address.port,
    })
    await expect(roundTrip(stream, 'local route')).resolves.toBe('local route')
  })
})

describe('loopback URL policy', () => {
  it.each([
    ['http://localhost:5173/deep?q=1', 'localhost', 5173],
    ['http://127.0.0.1/', '127.0.0.1', 80],
    ['http://[::1]:8080/', '::1', 8080],
    ['http://0.0.0.0:4173/', 'localhost', 4173],
    ['http://[::]:4173/', 'localhost', 4173],
  ] as const)('accepts %s', (url, hostname, port) => {
    const target = parseLoopbackHttpTarget(url)
    expect(target?.endpoint).toEqual({ hostname, port })
    if (url.includes('0.0.0.0') || url.includes('[::]')) {
      expect(target?.url).toContain('localhost')
    }
  })

  it.each([
    'https://localhost:5173/',
    'http://user:pass@localhost:5173/',
    'http://example.com:5173/',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseLoopbackHttpTarget(url)).toBeUndefined()
  })
})

describe('authenticated pane proxy', () => {
  it('rejects unauthenticated local clients and strips credentials upstream', async () => {
    let upstreamProxyAuthorization: string | undefined
    let upstreamHost: string | undefined
    const server = createHttpServer((request, response) => {
      upstreamProxyAuthorization = request.headers['proxy-authorization']
      upstreamHost = request.headers.host
      response.end('proxy-ok')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')

    const proxy = new LoopbackHttpProxy({
      host: new LocalHost(),
      endpoint: { hostname: 'localhost', port: address.port },
    })
    await proxy.open()
    cleanups.push(() => proxy.close())
    const absoluteUrl = `http://localhost:${address.port}/deep?q=1`

    const rejected = await proxyGet(proxy.port, absoluteUrl)
    expect(rejected.status).toBe(407)
    expect(rejected.authenticate).toContain(proxy.credentials.realm)

    const accepted = await proxyGet(proxy.port, absoluteUrl, proxy.credentials)
    expect(accepted).toEqual(expect.objectContaining({ status: 200, body: 'proxy-ok' }))
    expect(upstreamProxyAuthorization).toBeUndefined()
    expect(upstreamHost).toBe(`localhost:${address.port}`)
  })

  it('never falls through an authorized remote endpoint to the local service', async () => {
    let localRequests = 0
    const localServer = createHttpServer((_request, response) => {
      localRequests++
      response.end('local-service')
    })
    await new Promise<void>((resolve, reject) => {
      localServer.once('error', reject)
      localServer.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(
      () => new Promise<void>((resolve) => localServer.close(() => resolve())),
    )
    const address = localServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')

    const connectLoopback = vi.fn(() =>
      Promise.resolve(
        new Duplex({
          read() {
            // Response is produced after the proxy writes the HTTP request.
          },
          write(_chunk, _encoding, callback) {
            this.push(
              'HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nremote-service',
            )
            this.push(null)
            callback()
          },
        }),
      ),
    )
    const remoteHost = {
      hostId: asHostId('remote-test'),
      connectLoopback,
    } as unknown as ProjectHost
    const proxy = new LoopbackHttpProxy({
      host: remoteHost,
      endpoint: { hostname: 'localhost', port: address.port },
    })
    await proxy.open()
    cleanups.push(() => proxy.close())

    const result = await proxyGet(
      proxy.port,
      `http://localhost:${address.port}/`,
      proxy.credentials,
    )
    expect(result.body).toBe('remote-service')
    expect(localRequests).toBe(0)
    expect(connectLoopback).toHaveBeenCalledWith({
      hostname: 'localhost',
      port: address.port,
    })
  })

  it('blocks an authenticated request to another loopback endpoint', async () => {
    const onDiagnostic = vi.fn()
    const proxy = new LoopbackHttpProxy({
      host: new LocalHost(),
      endpoint: { hostname: '127.0.0.1', port: 31_337 },
      onDiagnostic,
    })
    await proxy.open()
    cleanups.push(() => proxy.close())

    const result = await proxyGet(
      proxy.port,
      'http://127.0.0.1:31338/private?token=secret#fragment',
      proxy.credentials,
    )
    expect(result.status).toBe(403)
    expect(onDiagnostic).toHaveBeenCalledWith({
      kind: 'request-failure',
      message: 'Loopback endpoint is not authorized',
      url: 'http://127.0.0.1:31338/private',
    })
  })

  it('authenticates CONNECT and carries WebSocket-style duplex traffic', async () => {
    const server = createTcpServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')

    const proxy = new LoopbackHttpProxy({
      host: new LocalHost(),
      endpoint: { hostname: '127.0.0.1', port: address.port },
    })
    await proxy.open()
    cleanups.push(() => proxy.close())

    await expect(
      proxyConnectRoundTrip(
        proxy.port,
        `127.0.0.1:${address.port}`,
        proxy.credentials,
        'websocket-frame',
      ),
    ).resolves.toBe('websocket-frame')
  })
})

function proxyGet(
  proxyPort: number,
  url: string,
  credentials?: { readonly username: string; readonly password: string },
): Promise<{ status?: number; body: string; authenticate?: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: credentials
        ? {
            'proxy-authorization': `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          }
        : undefined,
    })
    let body = ''
    request.on('response', (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          body,
          authenticate: response.headers['proxy-authenticate'],
        }),
      )
    })
    request.on('error', reject)
    request.end()
  })
}

function proxyConnectRoundTrip(
  proxyPort: number,
  authority: string,
  credentials: { readonly username: string; readonly password: string },
  payload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port: proxyPort })
    let received = Buffer.alloc(0)
    let connected = false
    socket.on('connect', () => {
      const authorization = Buffer.from(
        `${credentials.username}:${credentials.password}`,
      ).toString('base64')
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
      )
    })
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (!connected) {
        const separator = received.indexOf('\r\n\r\n')
        if (separator < 0) return
        const status = received.subarray(0, separator).toString('utf8')
        if (!status.startsWith('HTTP/1.1 200')) {
          socket.destroy()
          reject(new Error(status))
          return
        }
        connected = true
        received = received.subarray(separator + 4)
        socket.write(payload)
      }
      if (received.toString('utf8').includes(payload)) {
        socket.destroy()
        resolve(payload)
      }
    })
    socket.on('error', reject)
  })
}
