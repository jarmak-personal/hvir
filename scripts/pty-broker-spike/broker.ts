// The issue #215 spike is deliberately outside the production ProjectHost graph.
// eslint-disable-next-line no-restricted-imports
import { constants, type FileHandle, chmod, open, rmdir, unlink } from 'node:fs/promises'
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'

// The broker is the experimental physical-PTY edge; production imports remain unchanged.
// eslint-disable-next-line no-restricted-imports
import type { IPty } from 'node-pty'

import { BoundedReplayStore } from './bounded-replay.ts'
import { clientFrameDisposition } from './client-queue.ts'
import {
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  MAX_PROTOCOL_FRAME_BYTES,
  encodeBrokerFrame,
  parseAttachBody,
  parseAttachmentAuthority,
  parseBrokerRequest,
  parseResizeBody,
  parseSpawnBody,
  parseWriteBody,
  type BrokerAttachResult,
  type BrokerBootstrap,
  type BrokerEvent,
  type BrokerFailureResponse,
  type BrokerFrame,
  type BrokerLimits,
  type BrokerRequest,
  type BrokerSessionStatus,
  type BrokerSpawnBody,
  type BrokerSpawnResult,
  type BrokerSuccessResponse,
} from './protocol.ts'

interface Attachment {
  readonly connection: BrokerConnection
  readonly epoch: number
  readonly token: string
}

interface LiveSession {
  readonly id: string
  readonly token: string
  readonly pty: IPty
  readonly pid: number
  readonly startedAt: number
  readonly leaseMs: number
  readonly exitPromise: Promise<void>
  readonly resolveExit: () => void
  sequence: number
  attachmentEpoch: number
  attachment?: Attachment
  orphanedAt?: number
  orphanDeadline?: number
  orphanTimer?: ReturnType<typeof setTimeout>
  tombstoneTimer?: ReturnType<typeof setTimeout>
  termination?: Promise<void>
  state: 'live' | 'exited'
  exitCode?: number
  signal?: number
  replayDroppedReported: number
}

interface DroppedQueueData {
  readonly sessionId: string
  readonly epoch: number
  bytes: number
}

class BrokerConnection {
  readonly id: string
  private readonly socket: Socket
  private readonly broker: PtyBroker
  private readonly maxQueueBytes: number
  private input = ''
  private requests = Promise.resolve()
  private closed = false
  private readonly attachedSessions = new Set<string>()
  private readonly droppedData = new Map<string, DroppedQueueData>()

  constructor(id: string, socket: Socket, broker: PtyBroker, maxQueueBytes: number) {
    this.id = id
    this.socket = socket
    this.broker = broker
    this.maxQueueBytes = maxQueueBytes
    socket.setNoDelay(true)
    socket.setEncoding('utf8')
    socket.on('data', (data: string) => this.receive(data))
    socket.on('drain', () => this.flushDroppedData())
    socket.on('error', () => undefined)
    socket.once('close', () => {
      this.closed = true
      broker.connectionClosed(this, [...this.attachedSessions])
      this.attachedSessions.clear()
      this.droppedData.clear()
    })
  }

  trackSession(sessionId: string): void {
    this.attachedSessions.add(sessionId)
  }

  untrackSession(sessionId: string): void {
    this.attachedSessions.delete(sessionId)
  }

  isOpen(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  send(frame: BrokerFrame): boolean {
    if (this.closed || this.socket.destroyed) return false
    const encoded = encodeBrokerFrame(frame)
    const bytes = Buffer.byteLength(encoded, 'utf8')
    if (
      clientFrameDisposition(
        this.socket.writableLength,
        bytes,
        this.maxQueueBytes,
        false,
      ) === 'disconnect'
    ) {
      this.socket.destroy()
      return false
    }
    this.socket.write(encoded)
    return true
  }

  sendData(event: Extract<BrokerEvent, { readonly event: 'data' }>): void {
    if (this.closed || this.socket.destroyed) return
    this.flushDroppedData()
    const encoded = encodeBrokerFrame(event)
    const bytes = Buffer.byteLength(encoded, 'utf8')
    if (
      clientFrameDisposition(
        this.socket.writableLength,
        bytes,
        this.maxQueueBytes,
        true,
      ) === 'drop'
    ) {
      const key = `${event.sessionId}:${event.epoch}`
      const dropped = this.droppedData.get(key) ?? {
        sessionId: event.sessionId,
        epoch: event.epoch,
        bytes: 0,
      }
      dropped.bytes += Buffer.byteLength(event.data, 'utf8')
      this.droppedData.set(key, dropped)
      return
    }
    this.socket.write(encoded)
  }

  destroy(): void {
    this.socket.destroy()
  }

  private receive(data: string): void {
    this.input += data
    if (Buffer.byteLength(this.input, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
      this.socket.destroy()
      return
    }
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) return
      const line = this.input.slice(0, newline)
      this.input = this.input.slice(newline + 1)
      if (!line) continue
      let request: BrokerRequest
      try {
        request = parseBrokerRequest(line)
      } catch {
        this.socket.destroy()
        return
      }
      this.requests = this.requests
        .then(() => this.broker.handleRequest(this, request))
        .catch(() => {
          this.socket.destroy()
        })
    }
  }

  private flushDroppedData(): void {
    if (this.closed || this.socket.destroyed) return
    for (const [key, dropped] of this.droppedData) {
      const event: BrokerEvent = {
        version: BROKER_PROTOCOL_VERSION,
        type: 'event',
        event: 'overflow',
        sessionId: dropped.sessionId,
        epoch: dropped.epoch,
        scope: 'client-queue',
        droppedBytes: dropped.bytes,
      }
      const encoded = encodeBrokerFrame(event)
      const bytes = Buffer.byteLength(encoded, 'utf8')
      if (this.socket.writableLength + bytes > this.maxQueueBytes) return
      this.socket.write(encoded)
      this.droppedData.delete(key)
    }
  }
}

class PtyBroker {
  private readonly runtimeDirectory: string
  private readonly socketPath: string
  private readonly brokerToken: string
  private readonly limits: BrokerLimits
  private readonly sessions = new Map<string, LiveSession>()
  private readonly connections = new Set<BrokerConnection>()
  private readonly replay: BoundedReplayStore
  private server?: Server
  private idleTimer?: ReturnType<typeof setTimeout>
  private shuttingDown = false

  constructor(
    runtimeDirectory: string,
    socketPath: string,
    brokerToken: string,
    limits: BrokerLimits,
  ) {
    this.runtimeDirectory = runtimeDirectory
    this.socketPath = socketPath
    this.brokerToken = brokerToken
    this.limits = limits
    this.replay = new BoundedReplayStore(
      limits.perSessionReplayBytes,
      limits.globalReplayBytes,
    )
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      if (this.shuttingDown || this.connections.size >= this.limits.maxConnections) {
        socket.destroy()
        return
      }
      this.cancelIdleExit()
      const connection = new BrokerConnection(
        randomUUID(),
        socket,
        this,
        this.limits.clientQueueBytes,
      )
      this.connections.add(connection)
      socket.once('close', () => {
        this.connections.delete(connection)
        this.scheduleIdleExit()
      })
    })
    this.server.on('error', () => void this.shutdown(1))
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error): void => {
        this.server?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server?.off('error', onError)
        resolveStart()
      }
      this.server!.once('error', onError)
      this.server!.once('listening', onListening)
      this.server!.listen(this.socketPath)
    })
    await chmod(this.socketPath, 0o600)
    this.scheduleIdleExit()
  }

  async handleRequest(
    connection: BrokerConnection,
    request: BrokerRequest,
  ): Promise<void> {
    try {
      if (!capabilityEquals(request.brokerToken, this.brokerToken)) {
        throw new BrokerProtocolError(
          'AUTHENTICATION_FAILED',
          'Broker authentication failed',
        )
      }
      this.requireRunning()
      const result = await this.perform(connection, request)
      const response: BrokerSuccessResponse = {
        version: BROKER_PROTOCOL_VERSION,
        type: 'response',
        requestId: request.requestId,
        ok: true,
        result,
      }
      connection.send(response)
    } catch (error) {
      const failure = protocolFailure(request.requestId, error)
      connection.send(failure)
    }
  }

  connectionClosed(connection: BrokerConnection, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId)
      if (!session || session.attachment?.connection !== connection) continue
      session.attachment = undefined
      this.beginOrphanLease(session)
    }
    this.scheduleIdleExit()
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.cancelIdleExit()
    const serverClosed = new Promise<void>((resolveClose) => {
      if (!this.server?.listening) {
        resolveClose()
        return
      }
      this.server.close(() => resolveClose())
    })
    const terminations = [...this.sessions.values()]
      .filter((session) => session.state === 'live')
      .map((session) => this.terminateOwnedSession(session))
    await Promise.allSettled(terminations)
    for (const connection of this.connections) connection.destroy()
    this.connections.clear()
    await serverClosed
    await removeRuntimeEndpoint(this.socketPath, this.runtimeDirectory)
    process.exitCode = exitCode
  }

  private async perform(
    connection: BrokerConnection,
    request: BrokerRequest,
  ): Promise<unknown> {
    switch (request.operation) {
      case 'status': {
        const usage = process.cpuUsage()
        const memory = process.memoryUsage()
        return {
          protocolVersion: BROKER_PROTOCOL_VERSION,
          brokerPid: process.pid,
          sessionCount: this.sessions.size,
          limits: this.limits,
          rssBytes: memory.rss,
          cpuUserMicros: usage.user,
          cpuSystemMicros: usage.system,
        }
      }
      case 'list':
        return [...this.sessions.values()]
          .map((session) => this.sessionStatus(session))
          .sort((left, right) => left.startedAt - right.startedAt)
      case 'spawn':
        return this.spawn(connection, parseSpawnBody(request.body, this.limits))
      case 'attach': {
        const body = parseAttachBody(request.body)
        return this.attach(connection, body, body.afterSequence)
      }
      case 'detach': {
        const authority = parseAttachmentAuthority(request.body)
        const session = this.requireAttachment(connection, authority)
        session.attachment = undefined
        connection.untrackSession(session.id)
        this.beginOrphanLease(session)
        return { orphanDeadline: session.orphanDeadline }
      }
      case 'write': {
        const body = parseWriteBody(request.body)
        this.requireAttachment(connection, body).pty.write(body.data)
        return {}
      }
      case 'resize': {
        const body = parseResizeBody(request.body)
        this.requireAttachment(connection, body).pty.resize(body.cols, body.rows)
        return {}
      }
      case 'terminate': {
        const authority = parseAttachmentAuthority(request.body)
        const session = this.requireAttachment(connection, authority)
        await this.terminateOwnedSession(session)
        return {}
      }
    }
  }

  private async spawn(
    connection: BrokerConnection,
    body: BrokerSpawnBody,
  ): Promise<BrokerSpawnResult> {
    if (this.sessions.size >= this.limits.maxSessions) {
      throw new BrokerProtocolError('CAPACITY', 'Broker session capacity is exhausted')
    }
    const environment = { ...process.env }
    for (const key of body.unsetEnv ?? []) delete environment[key]
    Object.assign(environment, body.env)
    let pty: IPty
    try {
      // eslint-disable-next-line no-restricted-syntax
      const nodePty = await import('node-pty')
      // The dynamic import yields. Recheck after it so a spawn already admitted
      // when shutdown began cannot escape the termination snapshot.
      this.requireRunning()
      pty = nodePty.spawn(body.file, [...body.args], {
        cwd: body.cwd,
        env: environment,
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
        name: body.name ?? 'xterm-256color',
      })
    } catch (error) {
      throw new BrokerProtocolError('SPAWN_FAILED', spawnFailure(error))
    }

    const id = randomUUID()
    let resolveExit = (): void => undefined
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise
    })
    const session: LiveSession = {
      id,
      token: capability(),
      pty,
      pid: pty.pid,
      startedAt: Date.now(),
      leaseMs: body.leaseMs ?? this.limits.defaultLeaseMs,
      exitPromise,
      resolveExit,
      sequence: 0,
      attachmentEpoch: 1,
      state: 'live',
      replayDroppedReported: 0,
    }
    const attachmentToken = capability()
    this.sessions.set(id, session)
    pty.onData((data) => this.receivePtyData(session, data))
    pty.onExit((exit) => this.sessionExited(session, exit.exitCode, exit.signal))
    if (connection.isOpen()) {
      session.attachment = {
        connection,
        epoch: session.attachmentEpoch,
        token: attachmentToken,
      }
      connection.trackSession(id)
    } else {
      this.beginOrphanLease(session)
    }
    this.cancelIdleExit()
    return {
      sessionId: id,
      sessionToken: session.token,
      epoch: session.attachmentEpoch,
      attachmentToken,
      pid: session.pid,
      startedAt: session.startedAt,
    }
  }

  private attach(
    connection: BrokerConnection,
    authority: ReturnType<typeof parseAttachBody>,
    afterSequence = 0,
  ): BrokerAttachResult {
    const session = this.requireSession(authority.sessionId, authority.sessionToken)
    if (session.state !== 'live') {
      throw new BrokerProtocolError('SESSION_EXITED', 'Broker session has exited')
    }
    const previous = session.attachment
    if (previous) {
      previous.connection.untrackSession(session.id)
      previous.connection.send({
        version: BROKER_PROTOCOL_VERSION,
        type: 'event',
        event: 'revoked',
        sessionId: session.id,
        epoch: previous.epoch,
      })
    }
    this.clearOrphanLease(session)
    session.attachmentEpoch++
    const attachmentToken = capability()
    session.attachment = {
      connection,
      epoch: session.attachmentEpoch,
      token: attachmentToken,
    }
    connection.trackSession(session.id)
    const replay = this.replay.snapshot(session.id, afterSequence)
    // The attach result reports the cumulative loss through this snapshot.
    // Future overflow events for the new epoch report only later loss.
    session.replayDroppedReported = replay.droppedBytes
    return {
      sessionId: session.id,
      sessionToken: session.token,
      epoch: session.attachmentEpoch,
      attachmentToken,
      pid: session.pid,
      replay: replay.chunks,
      replayBytes: replay.bytes,
      replayDroppedBytes: replay.droppedBytes,
    }
  }

  private receivePtyData(session: LiveSession, data: string): void {
    if (session.state !== 'live') return
    session.sequence++
    this.replay.append(session.id, session.sequence, data)
    const replayStatus = this.replay.status(session.id)
    const attachment = session.attachment
    if (attachment && replayStatus.droppedBytes > session.replayDroppedReported) {
      const newlyDropped = replayStatus.droppedBytes - session.replayDroppedReported
      session.replayDroppedReported = replayStatus.droppedBytes
      attachment.connection.send({
        version: BROKER_PROTOCOL_VERSION,
        type: 'event',
        event: 'overflow',
        sessionId: session.id,
        epoch: attachment.epoch,
        scope: 'replay',
        droppedBytes: newlyDropped,
      })
    }
    attachment?.connection.sendData({
      version: BROKER_PROTOCOL_VERSION,
      type: 'event',
      event: 'data',
      sessionId: session.id,
      epoch: attachment.epoch,
      sequence: session.sequence,
      data,
    })
  }

  private sessionExited(
    session: LiveSession,
    exitCode: number,
    signal: number | undefined,
  ): void {
    if (session.state === 'exited') return
    session.state = 'exited'
    session.exitCode = exitCode
    session.signal = signal
    session.resolveExit()
    this.clearOrphanLease(session)
    const attachment = session.attachment
    if (attachment) {
      attachment.connection.send({
        version: BROKER_PROTOCOL_VERSION,
        type: 'event',
        event: 'exit',
        sessionId: session.id,
        epoch: attachment.epoch,
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      })
      attachment.connection.untrackSession(session.id)
      session.attachment = undefined
    }
    session.tombstoneTimer = setTimeout(
      () => this.forgetSession(session),
      this.limits.tombstoneMs,
    )
    session.tombstoneTimer.unref()
  }

  private sessionStatus(session: LiveSession): BrokerSessionStatus {
    const replay = this.replay.status(session.id)
    return {
      sessionId: session.id,
      pid: session.pid,
      startedAt: session.startedAt,
      state: session.state,
      attachmentEpoch: session.attachmentEpoch,
      orphanedAt: session.orphanedAt,
      orphanDeadline: session.orphanDeadline,
      replayBytes: replay.bytes,
      replayDroppedBytes: replay.droppedBytes,
      exitCode: session.exitCode,
      signal: session.signal,
    }
  }

  private requireSession(sessionId: string, sessionToken: string): LiveSession {
    const session = this.sessions.get(sessionId)
    if (!session || !capabilityEquals(session.token, sessionToken)) {
      throw new BrokerProtocolError('UNKNOWN_SESSION', 'Broker session is unavailable')
    }
    return session
  }

  private requireRunning(): void {
    if (this.shuttingDown) {
      throw new BrokerProtocolError('BROKER_SHUTTING_DOWN', 'Broker is shutting down')
    }
  }

  private requireAttachment(
    connection: BrokerConnection,
    authority: ReturnType<typeof parseAttachmentAuthority>,
  ): LiveSession {
    const session = this.requireSession(authority.sessionId, authority.sessionToken)
    const attachment = session.attachment
    if (
      session.state !== 'live' ||
      !attachment ||
      attachment.connection !== connection ||
      attachment.epoch !== authority.epoch ||
      !capabilityEquals(attachment.token, authority.attachmentToken)
    ) {
      throw new BrokerProtocolError(
        'STALE_ATTACHMENT',
        'Broker attachment authority is stale',
      )
    }
    return session
  }

  private beginOrphanLease(session: LiveSession): void {
    if (session.state !== 'live') return
    this.clearOrphanLease(session)
    const now = Date.now()
    session.orphanedAt = now
    session.orphanDeadline = now + session.leaseMs
    session.orphanTimer = setTimeout(() => {
      session.orphanTimer = undefined
      void this.terminateOwnedSession(session)
    }, session.leaseMs)
    session.orphanTimer.unref()
  }

  private clearOrphanLease(session: LiveSession): void {
    if (session.orphanTimer) clearTimeout(session.orphanTimer)
    session.orphanTimer = undefined
    session.orphanedAt = undefined
    session.orphanDeadline = undefined
  }

  private terminateOwnedSession(session: LiveSession): Promise<void> {
    if (session.state === 'exited') return Promise.resolve()
    if (session.termination) return session.termination
    session.termination = this.performTermination(session)
    return session.termination
  }

  private async performTermination(session: LiveSession): Promise<void> {
    this.clearOrphanLease(session)
    signalOwnedGroup(session, 'SIGTERM')
    if (!(await exitsBefore(session.exitPromise, this.limits.terminationGraceMs))) {
      signalOwnedGroup(session, 'SIGKILL')
      await exitsBefore(session.exitPromise, this.limits.terminationGraceMs)
    }
  }

  private forgetSession(session: LiveSession): void {
    if (this.sessions.get(session.id) !== session) return
    if (session.orphanTimer) clearTimeout(session.orphanTimer)
    if (session.tombstoneTimer) clearTimeout(session.tombstoneTimer)
    this.replay.delete(session.id)
    this.sessions.delete(session.id)
    this.scheduleIdleExit()
  }

  private scheduleIdleExit(): void {
    if (
      this.shuttingDown ||
      this.idleTimer ||
      this.sessions.size > 0 ||
      this.connections.size > 0
    ) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.sessions.size === 0 && this.connections.size === 0) {
        void this.shutdown()
      }
    }, this.limits.idleExitMs)
    this.idleTimer.unref()
  }

  private cancelIdleExit(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

async function loadBootstrap(runtimeDirectory: string): Promise<BrokerBootstrap> {
  const absoluteDirectory = resolve(runtimeDirectory)
  if (absoluteDirectory !== runtimeDirectory) {
    throw new Error('Broker runtime directory must be absolute')
  }
  const bootstrapPath = join(runtimeDirectory, 'bootstrap.json')
  let handle: FileHandle | undefined
  try {
    handle = await open(bootstrapPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const [directoryStat, bootstrapStat, raw] = await Promise.all([
      open(runtimeDirectory, constants.O_RDONLY).then(async (directory) => {
        try {
          return await directory.stat()
        } finally {
          await directory.close()
        }
      }),
      handle.stat(),
      handle.readFile('utf8'),
    ])
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (
      !directoryStat.isDirectory() ||
      (directoryStat.mode & 0o077) !== 0 ||
      !bootstrapStat.isFile() ||
      (bootstrapStat.mode & 0o077) !== 0 ||
      (uid !== undefined && (directoryStat.uid !== uid || bootstrapStat.uid !== uid))
    ) {
      throw new Error('Broker bootstrap permissions are unsafe')
    }
    const value = JSON.parse(raw) as Partial<BrokerBootstrap>
    if (
      value.version !== BROKER_PROTOCOL_VERSION ||
      typeof value.brokerToken !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.brokerToken) ||
      !value.limits
    ) {
      throw new Error('Broker bootstrap is invalid')
    }
    validateLimits(value.limits)
    return value as BrokerBootstrap
  } finally {
    await handle?.close()
    await unlink(bootstrapPath).catch(() => undefined)
  }
}

function validateLimits(limits: BrokerLimits): void {
  const values = [
    limits.perSessionReplayBytes,
    limits.globalReplayBytes,
    limits.clientQueueBytes,
    limits.defaultLeaseMs,
    limits.terminationGraceMs,
    limits.tombstoneMs,
    limits.idleExitMs,
  ]
  if (
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 4 * 60 * 60 * 1000,
    ) ||
    !Number.isSafeInteger(limits.maxConnections) ||
    limits.maxConnections < 1 ||
    limits.maxConnections > 256 ||
    !Number.isSafeInteger(limits.maxSessions) ||
    limits.maxSessions < 1 ||
    limits.maxSessions > 1024 ||
    limits.globalReplayBytes < limits.perSessionReplayBytes ||
    limits.clientQueueBytes < 4096
  ) {
    throw new Error('Broker limits are invalid')
  }
}

function protocolFailure(requestId: string, error: unknown): BrokerFailureResponse {
  const known =
    error instanceof BrokerProtocolError
      ? error
      : new BrokerProtocolError('BROKER_FAILURE', 'Broker operation failed')
  return {
    version: BROKER_PROTOCOL_VERSION,
    type: 'response',
    requestId,
    ok: false,
    error: { code: known.code, message: known.message },
  }
}

function spawnFailure(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN'
  return `PTY spawn failed (${code})`
}

function capability(): string {
  return randomBytes(32).toString('base64url')
}

function capabilityEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function signalOwnedGroup(session: LiveSession, signal: NodeJS.Signals): void {
  if (
    !Number.isSafeInteger(session.pid) ||
    session.pid <= 1 ||
    session.state !== 'live'
  ) {
    return
  }
  try {
    process.kill(-session.pid, signal)
  } catch (error) {
    if (errorCode(error) === 'ESRCH') {
      try {
        session.pty.kill(signal)
      } catch {
        // The exact owned PTY has already exited.
      }
      return
    }
    throw error
  }
}

async function exitsBefore(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function removeRuntimeEndpoint(
  socketPath: string,
  runtimeDirectory: string,
): Promise<void> {
  await unlink(socketPath).catch(() => undefined)
  await rmdir(runtimeDirectory).catch(() => undefined)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

async function main(): Promise<void> {
  const runtimeDirectory = process.argv[2]
  if (!runtimeDirectory) throw new Error('Broker runtime directory is required')
  const bootstrap = await loadBootstrap(runtimeDirectory)
  const broker = new PtyBroker(
    runtimeDirectory,
    join(runtimeDirectory, 'broker.sock'),
    bootstrap.brokerToken,
    bootstrap.limits,
  )
  process.once('SIGINT', () => void broker.shutdown())
  process.once('SIGTERM', () => void broker.shutdown())
  await broker.start()
}

void main().catch(async () => {
  const runtimeDirectory = process.argv[2]
  if (runtimeDirectory) {
    await removeRuntimeEndpoint(join(runtimeDirectory, 'broker.sock'), runtimeDirectory)
  }
  process.exitCode = 1
})
