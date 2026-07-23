// The isolated spike client owns its disposable broker process, not a project host.
// eslint-disable-next-line no-restricted-imports
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
// The isolated spike uses only a private mkdtemp runtime directory.
// eslint-disable-next-line no-restricted-imports
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  BROKER_PROTOCOL_VERSION,
  MAX_PROTOCOL_FRAME_BYTES,
  parseBrokerFrame,
  type BrokerAttachResult,
  type BrokerAttachmentAuthority,
  type BrokerBootstrap,
  type BrokerEvent,
  type BrokerFrame,
  type BrokerLimits,
  type BrokerOperation,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerSessionAuthority,
  type BrokerSessionStatus,
  type BrokerSpawnBody,
  type BrokerSpawnResult,
} from './protocol.ts'

const require = createRequire(import.meta.url)
const electronModule = require('electron') as unknown
const electronExecutable =
  typeof electronModule === 'string' ? electronModule : process.execPath
const brokerEntry = fileURLToPath(new URL('./broker.ts', import.meta.url))
const RUNTIME_PREFIX = join(tmpdir(), 'hvir-pty-broker-spike-')

export const DEFAULT_SPIKE_BROKER_LIMITS: BrokerLimits = {
  maxConnections: 16,
  maxSessions: 64,
  perSessionReplayBytes: 64 * 1024,
  globalReplayBytes: 256 * 1024,
  clientQueueBytes: 128 * 1024,
  defaultLeaseMs: 60 * 60 * 1000,
  terminationGraceMs: 1_000,
  tombstoneMs: 500,
  idleExitMs: 250,
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export class BrokerRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrokerRequestError'
    this.code = code
  }
}

export class SpikeBrokerClient {
  private readonly socket: Socket
  private readonly brokerToken: string
  private input = ''
  private closed = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: BrokerEvent) => void>()

  private constructor(socket: Socket, brokerToken: string) {
    this.socket = socket
    this.brokerToken = brokerToken
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', (data: string) => this.receive(data))
    socket.on('error', (error) => this.fail(error))
    socket.once('close', () => this.fail(new Error('Broker connection closed')))
  }

  static connect(socketPath: string, brokerToken: string): Promise<SpikeBrokerClient> {
    return new Promise((resolveClient, reject) => {
      const socket = createConnection(socketPath)
      const onError = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        resolveClient(new SpikeBrokerClient(socket, brokerToken))
      })
    })
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  status(): Promise<{
    readonly protocolVersion: number
    readonly brokerPid: number
    readonly sessionCount: number
    readonly limits: BrokerLimits
    readonly rssBytes: number
    readonly cpuUserMicros: number
    readonly cpuSystemMicros: number
  }> {
    return this.request('status', {}) as Promise<{
      readonly protocolVersion: number
      readonly brokerPid: number
      readonly sessionCount: number
      readonly limits: BrokerLimits
      readonly rssBytes: number
      readonly cpuUserMicros: number
      readonly cpuSystemMicros: number
    }>
  }

  list(): Promise<readonly BrokerSessionStatus[]> {
    return this.request('list', {}) as Promise<readonly BrokerSessionStatus[]>
  }

  spawn(body: BrokerSpawnBody): Promise<BrokerSpawnResult> {
    return this.request('spawn', body) as Promise<BrokerSpawnResult>
  }

  attach(
    authority: BrokerSessionAuthority,
    afterSequence?: number,
  ): Promise<BrokerAttachResult> {
    return this.request('attach', {
      ...authority,
      afterSequence,
    }) as Promise<BrokerAttachResult>
  }

  async detach(authority: BrokerAttachmentAuthority): Promise<number> {
    const result = (await this.request('detach', authority)) as {
      readonly orphanDeadline: number
    }
    return result.orphanDeadline
  }

  async write(authority: BrokerAttachmentAuthority, data: string): Promise<void> {
    await this.request('write', { ...authority, data })
  }

  async resize(
    authority: BrokerAttachmentAuthority,
    cols: number,
    rows: number,
  ): Promise<void> {
    await this.request('resize', { ...authority, cols, rows })
  }

  async terminate(authority: BrokerAttachmentAuthority): Promise<void> {
    await this.request('terminate', authority)
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolveClose) => {
      this.socket.once('close', () => resolveClose())
      this.socket.end()
    })
  }

  crash(): void {
    this.socket.destroy()
  }

  private request(operation: BrokerOperation, body: unknown): Promise<unknown> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error('Broker connection is closed'))
    }
    const requestId = randomUUID()
    const request: BrokerRequest = {
      version: BROKER_PROTOCOL_VERSION,
      type: 'request',
      requestId,
      brokerToken: this.brokerToken,
      operation,
      body,
    }
    const encoded = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
      return Promise.reject(new Error('Broker request exceeds the frame limit'))
    }
    return new Promise((resolveRequest, reject) => {
      this.pending.set(requestId, { resolve: resolveRequest, reject })
      this.socket.write(encoded, (error) => {
        if (!error) return
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  private receive(data: string): void {
    this.input += data
    if (Buffer.byteLength(this.input, 'utf8') > MAX_PROTOCOL_FRAME_BYTES * 2) {
      this.socket.destroy(new Error('Broker response buffer exceeded its bound'))
      return
    }
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) return
      const line = this.input.slice(0, newline)
      this.input = this.input.slice(newline + 1)
      if (!line) continue
      let frame: BrokerFrame
      try {
        frame = parseBrokerFrame(line)
      } catch (error) {
        this.socket.destroy(error as Error)
        return
      }
      if (frame.type === 'event') {
        for (const listener of this.eventListeners) listener(frame)
        continue
      }
      this.settle(frame)
    }
  }

  private settle(response: BrokerResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (response.ok) pending.resolve(response.result)
    else
      pending.reject(new BrokerRequestError(response.error.code, response.error.message))
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.eventListeners.clear()
  }
}

export interface SpikeBrokerHandle {
  readonly runtimeDirectory: string
  readonly socketPath: string
  readonly brokerToken: string
  readonly pid: number
  connect(): Promise<SpikeBrokerClient>
  cleanup(): Promise<void>
}

export async function startSpikeBroker(
  limitOverrides: Partial<BrokerLimits> = {},
): Promise<SpikeBrokerHandle> {
  const runtimeDirectory = await mkdtemp(RUNTIME_PREFIX)
  await chmod(runtimeDirectory, 0o700)
  const socketPath = join(runtimeDirectory, 'broker.sock')
  const brokerToken = randomBytes(32).toString('base64url')
  const bootstrap: BrokerBootstrap = {
    version: BROKER_PROTOCOL_VERSION,
    brokerToken,
    limits: { ...DEFAULT_SPIKE_BROKER_LIMITS, ...limitOverrides },
  }
  const bootstrapPath = join(runtimeDirectory, 'bootstrap.json')
  await writeFile(bootstrapPath, JSON.stringify(bootstrap), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  const child = spawn(electronExecutable, [brokerEntry, runtimeDirectory], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HVIR_PTY_BROKER_SPIKE: '1',
    },
  })
  child.unref()
  if (!child.pid) throw new Error('Detached broker did not report a pid')
  const pid = child.pid

  let initialClient: SpikeBrokerClient | undefined
  try {
    initialClient = await connectBeforeDeadline(socketPath, brokerToken, pid, 8_000)
    const status = await initialClient.status()
    if (status.protocolVersion !== BROKER_PROTOCOL_VERSION || status.brokerPid !== pid) {
      throw new Error('Detached broker identity did not match its startup record')
    }
  } catch (error) {
    await stopExactBroker(pid)
    await removeOwnedRuntimeDirectory(runtimeDirectory)
    throw error
  }

  let cleaned = false
  let keepalive: SpikeBrokerClient | undefined = initialClient
  return {
    runtimeDirectory,
    socketPath,
    brokerToken,
    pid,
    connect() {
      if (keepalive) {
        const client = keepalive
        keepalive = undefined
        return Promise.resolve(client)
      }
      return SpikeBrokerClient.connect(socketPath, brokerToken)
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      await keepalive?.close().catch(() => undefined)
      keepalive = undefined
      if (await pathExists(socketPath)) await stopExactBroker(pid)
      await removeOwnedRuntimeDirectory(runtimeDirectory)
    },
  }
}

export function attachmentAuthority(
  value: BrokerSpawnResult | BrokerAttachResult,
): BrokerAttachmentAuthority {
  return {
    sessionId: value.sessionId,
    sessionToken: value.sessionToken,
    epoch: value.epoch,
    attachmentToken: value.attachmentToken,
  }
}

export function sessionAuthority(
  value: BrokerSpawnResult | BrokerAttachResult,
): BrokerSessionAuthority {
  return {
    sessionId: value.sessionId,
    sessionToken: value.sessionToken,
  }
}

export function waitForBrokerEvent(
  client: SpikeBrokerClient,
  predicate: (event: BrokerEvent) => boolean,
  timeoutMs = 5_000,
): Promise<BrokerEvent> {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error('Timed out waiting for broker event'))
    }, timeoutMs)
    const dispose = client.onEvent((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      dispose()
      resolveEvent(event)
    })
  })
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true
    await delay(25)
  }
  return !processIsAlive(pid)
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

async function connectBeforeDeadline(
  socketPath: string,
  brokerToken: string,
  pid: number,
  timeoutMs: number,
): Promise<SpikeBrokerClient> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      throw new Error('Detached broker exited before accepting connections')
    }
    try {
      return await SpikeBrokerClient.connect(socketPath, brokerToken)
    } catch (error) {
      lastError = error
      await delay(25)
    }
  }
  throw new Error('Detached broker did not accept connections before its deadline', {
    cause: lastError,
  })
}

async function stopExactBroker(pid: number): Promise<void> {
  if (!processIsAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
  if (await waitForProcessExit(pid, 3_000)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
  await waitForProcessExit(pid, 3_000)
}

async function removeOwnedRuntimeDirectory(runtimeDirectory: string): Promise<void> {
  if (
    dirname(runtimeDirectory) !== tmpdir() ||
    !runtimeDirectory.startsWith(RUNTIME_PREFIX)
  ) {
    throw new Error('Refusing to remove an unowned broker runtime directory')
  }
  await rm(runtimeDirectory, { recursive: true, force: true })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
