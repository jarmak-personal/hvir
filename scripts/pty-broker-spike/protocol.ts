export const BROKER_PROTOCOL_VERSION = 1
export const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024
export const MAX_PTY_WRITE_BYTES = 256 * 1024

export type BrokerOperation =
  'status' | 'list' | 'spawn' | 'attach' | 'detach' | 'write' | 'resize' | 'terminate'

export interface BrokerRequest {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'request'
  readonly requestId: string
  readonly brokerToken: string
  readonly operation: BrokerOperation
  readonly body: unknown
}

export interface BrokerSuccessResponse {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'response'
  readonly requestId: string
  readonly ok: true
  readonly result: unknown
}

export interface BrokerFailureResponse {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'response'
  readonly requestId: string
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type BrokerResponse = BrokerSuccessResponse | BrokerFailureResponse

export interface BrokerDataEvent {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'event'
  readonly event: 'data'
  readonly sessionId: string
  readonly epoch: number
  readonly sequence: number
  readonly data: string
}

export interface BrokerOverflowEvent {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'event'
  readonly event: 'overflow'
  readonly sessionId: string
  readonly epoch: number
  readonly scope: 'replay' | 'client-queue'
  readonly droppedBytes: number
}

export interface BrokerExitEvent {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'event'
  readonly event: 'exit'
  readonly sessionId: string
  readonly epoch: number
  readonly exitCode: number
  readonly signal?: number
}

export interface BrokerRevokedEvent {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly type: 'event'
  readonly event: 'revoked'
  readonly sessionId: string
  readonly epoch: number
}

export type BrokerEvent =
  BrokerDataEvent | BrokerOverflowEvent | BrokerExitEvent | BrokerRevokedEvent

export type BrokerFrame = BrokerResponse | BrokerEvent

export interface BrokerLimits {
  readonly maxConnections: number
  readonly maxSessions: number
  readonly perSessionReplayBytes: number
  readonly globalReplayBytes: number
  readonly clientQueueBytes: number
  readonly defaultLeaseMs: number
  readonly terminationGraceMs: number
  readonly tombstoneMs: number
  readonly idleExitMs: number
}

export interface BrokerBootstrap {
  readonly version: typeof BROKER_PROTOCOL_VERSION
  readonly brokerToken: string
  readonly limits: BrokerLimits
}

export interface BrokerSpawnBody {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly unsetEnv?: readonly string[]
  readonly cols?: number
  readonly rows?: number
  readonly name?: string
  readonly leaseMs?: number
}

export interface BrokerSessionAuthority {
  readonly sessionId: string
  readonly sessionToken: string
}

export interface BrokerAttachmentAuthority extends BrokerSessionAuthority {
  readonly epoch: number
  readonly attachmentToken: string
}

export interface BrokerSpawnResult extends BrokerAttachmentAuthority {
  readonly pid: number
  readonly startedAt: number
}

export interface BrokerReplayChunk {
  readonly sequence: number
  readonly data: string
}

export interface BrokerAttachResult extends BrokerAttachmentAuthority {
  readonly pid: number
  readonly replay: readonly BrokerReplayChunk[]
  readonly replayBytes: number
  readonly replayDroppedBytes: number
}

export interface BrokerSessionStatus {
  readonly sessionId: string
  readonly pid: number
  readonly startedAt: number
  readonly state: 'live' | 'exited'
  readonly attachmentEpoch: number
  readonly orphanedAt?: number
  readonly orphanDeadline?: number
  readonly replayBytes: number
  readonly replayDroppedBytes: number
  readonly exitCode?: number
  readonly signal?: number
}

export class BrokerProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrokerProtocolError'
    this.code = code
  }
}

export function encodeBrokerFrame(frame: BrokerFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export function parseBrokerRequest(line: string): BrokerRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new BrokerProtocolError('INVALID_JSON', 'Broker request is not valid JSON')
  }
  if (!isRecord(value)) {
    throw new BrokerProtocolError('INVALID_REQUEST', 'Broker request must be an object')
  }
  if (value['version'] !== BROKER_PROTOCOL_VERSION) {
    throw new BrokerProtocolError(
      'INCOMPATIBLE_PROTOCOL',
      `Broker protocol version ${String(value['version'])} is not supported`,
    )
  }
  if (
    value['type'] !== 'request' ||
    !isIdentifier(value['requestId']) ||
    !isCapability(value['brokerToken']) ||
    !isBrokerOperation(value['operation'])
  ) {
    throw new BrokerProtocolError('INVALID_REQUEST', 'Broker request envelope is invalid')
  }
  return {
    version: BROKER_PROTOCOL_VERSION,
    type: 'request',
    requestId: value['requestId'],
    brokerToken: value['brokerToken'],
    operation: value['operation'],
    body: value['body'],
  }
}

export function parseSpawnBody(value: unknown, limits: BrokerLimits): BrokerSpawnBody {
  if (!isRecord(value)) invalidBody('spawn')
  const file = requiredString(value['file'], 'file', 4096)
  const cwd = requiredString(value['cwd'], 'cwd', 8192)
  if (!cwd.startsWith('/')) {
    throw new BrokerProtocolError('INVALID_BODY', 'spawn cwd must be absolute')
  }
  const args = stringArray(value['args'], 'args', 512, 64 * 1024)
  const env = optionalStringRecord(value['env'], 'env', 1024, MAX_PROTOCOL_FRAME_BYTES)
  const unsetEnv = optionalStringArray(value['unsetEnv'], 'unsetEnv', 1024, 4096)
  const cols = optionalDimension(value['cols'], 'cols')
  const rows = optionalDimension(value['rows'], 'rows')
  const name =
    value['name'] === undefined ? undefined : requiredString(value['name'], 'name', 128)
  const leaseMs =
    value['leaseMs'] === undefined
      ? undefined
      : boundedInteger(
          value['leaseMs'],
          'leaseMs',
          Math.min(25, limits.defaultLeaseMs),
          4 * 60 * 60 * 1000,
        )
  return { file, args, cwd, env, unsetEnv, cols, rows, name, leaseMs }
}

export function parseSessionAuthority(value: unknown): BrokerSessionAuthority {
  if (!isRecord(value)) invalidBody('session')
  return {
    sessionId: requiredIdentifier(value['sessionId'], 'sessionId'),
    sessionToken: requiredCapability(value['sessionToken'], 'sessionToken'),
  }
}

export function parseAttachmentAuthority(value: unknown): BrokerAttachmentAuthority {
  if (!isRecord(value)) invalidBody('attachment')
  return {
    ...parseSessionAuthority(value),
    epoch: boundedInteger(value['epoch'], 'epoch', 1, Number.MAX_SAFE_INTEGER),
    attachmentToken: requiredCapability(value['attachmentToken'], 'attachmentToken'),
  }
}

export function parseAttachBody(
  value: unknown,
): BrokerSessionAuthority & { readonly afterSequence?: number } {
  if (!isRecord(value)) invalidBody('attach')
  const authority = parseSessionAuthority(value)
  const afterSequence =
    value['afterSequence'] === undefined
      ? undefined
      : boundedInteger(
          value['afterSequence'],
          'afterSequence',
          0,
          Number.MAX_SAFE_INTEGER,
        )
  return { ...authority, afterSequence }
}

export function parseWriteBody(
  value: unknown,
): BrokerAttachmentAuthority & { readonly data: string } {
  if (!isRecord(value)) invalidBody('write')
  const authority = parseAttachmentAuthority(value)
  const data = requiredString(value['data'], 'data', MAX_PTY_WRITE_BYTES)
  if (Buffer.byteLength(data, 'utf8') > MAX_PTY_WRITE_BYTES) {
    throw new BrokerProtocolError(
      'INVALID_BODY',
      `write data exceeds ${MAX_PTY_WRITE_BYTES} bytes`,
    )
  }
  return { ...authority, data }
}

export function parseResizeBody(
  value: unknown,
): BrokerAttachmentAuthority & { readonly cols: number; readonly rows: number } {
  if (!isRecord(value)) invalidBody('resize')
  return {
    ...parseAttachmentAuthority(value),
    cols: requiredDimension(value['cols'], 'cols'),
    rows: requiredDimension(value['rows'], 'rows'),
  }
}

export function parseBrokerFrame(line: string): BrokerFrame {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new BrokerProtocolError('INVALID_JSON', 'Broker frame is not valid JSON')
  }
  if (
    !isRecord(value) ||
    value['version'] !== BROKER_PROTOCOL_VERSION ||
    (value['type'] !== 'response' && value['type'] !== 'event')
  ) {
    throw new BrokerProtocolError('INVALID_FRAME', 'Broker frame envelope is invalid')
  }
  return value as unknown as BrokerFrame
}

function requiredIdentifier(value: unknown, field: string): string {
  if (!isIdentifier(value)) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  return value
}

function requiredCapability(value: unknown, field: string): string {
  if (!isCapability(value)) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  return value
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  return value
}

function stringArray(
  value: unknown,
  field: string,
  maxEntries: number,
  maxEntryLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  return value.map((entry) => requiredString(entry, field, maxEntryLength))
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxEntries: number,
  maxEntryLength: number,
): string[] | undefined {
  return value === undefined
    ? undefined
    : stringArray(value, field, maxEntries, maxEntryLength)
}

function optionalStringRecord(
  value: unknown,
  field: string,
  maxEntries: number,
  maxBytes: number,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).length > maxEntries) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  const result: Record<string, string> = {}
  let totalBytes = 0
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string') {
      throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(entry, 'utf8')
    if (totalBytes > maxBytes) {
      throw new BrokerProtocolError('INVALID_BODY', `${field} is too large`)
    }
    result[key] = entry
  }
  return result
}

function optionalDimension(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requiredDimension(value, field)
}

function requiredDimension(value: unknown, field: string): number {
  return boundedInteger(value, field, 2, 1000)
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BrokerProtocolError('INVALID_BODY', `${field} is invalid`)
  }
  return value
}

function invalidBody(operation: string): never {
  throw new BrokerProtocolError('INVALID_BODY', `${operation} request body is invalid`)
}

function isBrokerOperation(value: unknown): value is BrokerOperation {
  return (
    value === 'status' ||
    value === 'list' ||
    value === 'spawn' ||
    value === 'attach' ||
    value === 'detach' ||
    value === 'write' ||
    value === 'resize' ||
    value === 'terminate'
  )
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,96}$/.test(value)
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
