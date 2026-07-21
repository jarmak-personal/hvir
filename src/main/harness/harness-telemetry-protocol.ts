export type HarnessTelemetryFollowerHealth =
  | { readonly status: 'pending'; readonly reason: 'awaiting-source' }
  | {
      readonly status: 'unavailable'
      readonly reason: 'resource-invalid' | 'follower-exited' | 'helper-exited'
    }

export type HarnessTelemetryHubFrame =
  | {
      readonly kind: 'event'
      readonly generation: number
      readonly subscriptionId: string
      readonly sessionId: string
      readonly record: string
    }
  | {
      readonly kind: 'health'
      readonly generation: number
      readonly subscriptionId: string
      readonly sessionId: string
      readonly health: HarnessTelemetryFollowerHealth
    }

export function parseHarnessTelemetryHubFrame(
  line: string,
  options: {
    readonly epoch: string
    readonly maxGeneration: number
    readonly maxEncodedLength: number
    readonly maxRecordBytes: number
  },
): HarnessTelemetryHubFrame | undefined {
  const fields = line.split('\t')
  const kind = fields[0]
  if ((kind === 'E' && fields.length !== 6) || (kind === 'H' && fields.length !== 7)) {
    return undefined
  }
  if (kind !== 'E' && kind !== 'H') return undefined

  const [, epoch, rawGeneration, subscriptionId, sessionId] = fields
  const generation = Number(rawGeneration)
  if (
    epoch !== options.epoch ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > options.maxGeneration ||
    !subscriptionId ||
    !sessionId
  ) {
    return undefined
  }

  if (kind === 'H') {
    const status = fields[5]
    const reason = fields[6]
    const health = followerHealth(status, reason)
    return health
      ? { kind: 'health', generation, subscriptionId, sessionId, health }
      : undefined
  }

  const encoded = fields[5]
  if (
    !encoded ||
    encoded.length > options.maxEncodedLength ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return undefined
  }
  const record = Buffer.from(encoded, 'base64').toString('utf8')
  return Buffer.byteLength(record, 'utf8') <= options.maxRecordBytes
    ? { kind: 'event', generation, subscriptionId, sessionId, record }
    : undefined
}

function followerHealth(
  status: string | undefined,
  reason: string | undefined,
): HarnessTelemetryFollowerHealth | undefined {
  if (status === 'pending' && reason === 'awaiting-source') {
    return { status, reason }
  }
  if (
    status === 'unavailable' &&
    (reason === 'resource-invalid' ||
      reason === 'follower-exited' ||
      reason === 'helper-exited')
  ) {
    return { status, reason }
  }
  return undefined
}
