import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { BlockList, connect as connectSocket, type Socket } from 'node:net'
import {
  Agent,
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'

import {
  loopbackEndpointEquals,
  parseLoopbackHttpTarget,
  type LoopbackEndpoint,
  type WebPaneDiagnosticEvent,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const MAX_PROXY_CONNECTIONS = 32
const MAX_PROXY_HEADER_BYTES = 16 * 1024
const PROXY_CONNECT_TIMEOUT_MS = 15_000
const blockedDirectAddresses = new BlockList()
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['224.0.0.0', 3, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  blockedDirectAddresses.addSubnet(network, prefix, family)
}

export interface ProxyCredentials {
  readonly username: string
  readonly password: string
  readonly realm: string
}

export interface LoopbackHttpProxyOptions {
  readonly host: ProjectHost
  readonly endpoint: LoopbackEndpoint
  readonly onDiagnostic?: (event: WebPaneDiagnosticEvent) => void
}

/**
 * An authenticated, pane-scoped HTTP proxy. It preserves the browser-visible
 * localhost origin while routing only the authorized loopback endpoint through
 * ProjectHost. Public HTTP resources use ordinary local networking.
 */
export class LoopbackHttpProxy {
  readonly credentials: ProxyCredentials = {
    username: randomBytes(24).toString('base64url'),
    password: randomBytes(32).toString('base64url'),
    realm: `hvir-${randomBytes(12).toString('hex')}`,
  }

  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private readonly upstreams = new Set<Duplex>()
  private listeningPort: number | undefined
  private closed = false

  constructor(private readonly options: LoopbackHttpProxyOptions) {
    this.server = createServer(
      { maxHeaderSize: MAX_PROXY_HEADER_BYTES },
      (request, response) => {
        void this.proxyRequest(request, response)
      },
    )
    this.server.on('connect', (request, socket, head) => {
      void this.proxyConnect(request, socket, head)
    })
    this.server.on('connection', (socket) => {
      if (this.clients.size >= MAX_PROXY_CONNECTIONS) {
        socket.destroy()
        return
      }
      this.clients.add(socket)
      socket.once('close', () => this.clients.delete(socket))
    })
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 5_000
  }

  get port(): number {
    if (this.listeningPort === undefined) throw new Error('Web pane proxy is not open')
    return this.listeningPort
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('Web pane proxy is closed')
    if (this.listeningPort !== undefined) return
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => reject(error)
      this.server.once('error', fail)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', fail)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new Error('Web pane proxy reported no loopback port')
    }
    this.listeningPort = address.port
  }

  matchesCredentials(username: string, password: string): boolean {
    return (
      safeEqual(username, this.credentials.username) &&
      safeEqual(password, this.credentials.password)
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.listeningPort = undefined
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    for (const upstream of this.upstreams) upstream.destroy()
    this.upstreams.clear()
    if (!this.server.listening) return
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async proxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.authorized(request.headers)) {
      this.requireAuthentication(response)
      return
    }
    let target: URL
    try {
      if (!request.url || !/^http:\/\//i.test(request.url)) {
        throw new ProxyRequestError(400, 'Absolute-form HTTP URL required')
      }
      target = new URL(request.url)
      this.validateTarget(target)
    } catch (error) {
      this.reportFailure('request-failure', error, request.url)
      this.failResponse(response, error)
      return
    }

    const headers = forwardedHeaders(request.headers)
    headers.host = target.host
    let targetStream: Duplex
    try {
      targetStream = await this.openTarget(target)
    } catch (error) {
      this.reportFailure('route-failure', error, target.href)
      this.failResponse(response, error)
      return
    }
    if (request.destroyed || this.closed) {
      targetStream.destroy()
      return
    }
    const agent = new Agent({ keepAlive: false, maxSockets: 1 })
    agent.createConnection = () => targetStream
    const upstream = requestHttp({
      protocol: 'http:',
      hostname: socketHostname(target.hostname),
      port: target.port ? Number(target.port) : 80,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent,
    })
    upstream.once('close', () => agent.destroy())
    upstream.once('response', (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      )
      upstreamResponse.pipe(response)
    })
    upstream.once('error', (error) => {
      this.reportFailure('route-failure', error, target.href)
      if (!response.headersSent) this.failResponse(response, error)
      else response.destroy(error)
    })
    request.once('aborted', () => upstream.destroy())
    request.pipe(upstream)
  }

  private async proxyConnect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.authorized(request.headers)) {
      socket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${this.credentials.realm}"\r\nConnection: close\r\n\r\n`,
      )
      return
    }
    try {
      if (!request.url || request.url.includes('@')) {
        throw new ProxyRequestError(400, 'Invalid CONNECT authority')
      }
      const target = new URL(`http://${request.url}/`)
      this.validateTarget(target)
      const upstream = await this.openTarget(target)
      if (socket.destroyed || this.closed) {
        upstream.destroy()
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
      upstream.once('error', () => socket.destroy())
      socket.pipe(upstream)
      upstream.pipe(socket)
    } catch (error) {
      this.reportFailure('route-failure', error, request.url)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    }
  }

  private authorized(headers: IncomingHttpHeaders): boolean {
    const value = headers['proxy-authorization']
    if (typeof value !== 'string' || !value.startsWith('Basic ')) return false
    let decoded: string
    try {
      decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8')
    } catch {
      return false
    }
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    return this.matchesCredentials(
      decoded.slice(0, separator),
      decoded.slice(separator + 1),
    )
  }

  private requireAuthentication(response: ServerResponse): void {
    response.writeHead(407, 'Proxy Authentication Required', {
      'proxy-authenticate': `Basic realm="${this.credentials.realm}"`,
      connection: 'close',
    })
    response.end()
  }

  private failResponse(response: ServerResponse, error: unknown): void {
    const status = error instanceof ProxyRequestError ? error.status : 502
    const message = error instanceof Error ? error.message : 'Bad Gateway'
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(message)
  }

  private validateTarget(target: URL): void {
    if (
      target.protocol !== 'http:' ||
      target.username.length > 0 ||
      target.password.length > 0
    ) {
      throw new ProxyRequestError(403, 'Blocked web pane destination')
    }
    const loopback = parseLoopbackHttpTarget(target.href)
    if (loopback && !loopbackEndpointEquals(loopback.endpoint, this.options.endpoint)) {
      throw new ProxyRequestError(403, 'Loopback endpoint is not authorized')
    }
  }

  private async openTarget(target: URL): Promise<Duplex> {
    if (this.closed) throw new Error('Web pane proxy is closed')
    const loopback = parseLoopbackHttpTarget(target.href)
    const stream = await connectWithTimeout(
      loopback
        ? this.options.host.connectLoopback(loopback.endpoint)
        : connectDirect(
            socketHostname(target.hostname),
            target.port ? Number(target.port) : 80,
          ),
    )
    if (this.closed) {
      stream.destroy()
      throw new Error('Web pane proxy closed during connect')
    }
    this.upstreams.add(stream)
    stream.once('close', () => this.upstreams.delete(stream))
    return stream
  }

  private reportFailure(
    kind: 'request-failure' | 'route-failure',
    error: unknown,
    rawUrl?: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error)
    this.options.onDiagnostic?.({
      kind,
      message: message.slice(0, 1_000),
      ...(rawUrl ? { url: diagnosticUrl(rawUrl) } : {}),
    })
  }
}

class ProxyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded['proxy-authorization']
  delete forwarded['proxy-connection']
  return forwarded
}

function socketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

async function connectDirect(host: string, port: number): Promise<Duplex> {
  const addresses = await lookup(host, { all: true, verbatim: true })
  const target = addresses.find(
    ({ address, family }) =>
      !blockedDirectAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4'),
  )
  if (!target) throw new Error('Blocked non-public web pane destination')
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: target.address, port, family: target.family })
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

function connectWithTimeout(pending: Promise<Duplex>): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => {
      finished = true
      reject(new Error('Web pane upstream connect timed out'))
    }, PROXY_CONNECT_TIMEOUT_MS)
    void pending.then(
      (stream) => {
        if (finished) {
          stream.destroy()
          return
        }
        finished = true
        clearTimeout(timer)
        resolve(stream)
      },
      (error: unknown) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function diagnosticUrl(rawUrl: string): string {
  try {
    const url = rawUrl.includes('://') ? new URL(rawUrl) : new URL(`http://${rawUrl}/`)
    return `${url.origin}${url.pathname}`.slice(0, 2_000)
  } catch {
    return '[invalid URL]'
  }
}
