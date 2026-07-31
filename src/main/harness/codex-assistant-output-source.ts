import { createHash } from 'node:crypto'

import { asHarnessProviderId, type AssistantOutputEvent, type HostId } from '../../shared'

const SOURCE_REVISION = 1
const MAX_SOURCE_RECORD_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 160
const MAX_RETAINED_SOURCE_IDENTITIES = 4_096
const IDENTIFIER = /^[\x21-\x7e]{1,160}$/
const DIGEST = /^[a-f0-9]{64}$/

interface ActiveMessage {
  readonly sessionId: string
  readonly turnId: string
  readonly messageId: string
  readonly hash: ReturnType<typeof createHash>
  bytes: number
}

interface SourceFrameBase {
  readonly revision: 1
  readonly sourceId: string
  readonly order: number
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
}

type SourceFrame =
  | (SourceFrameBase & { readonly kind: 'start' })
  | (SourceFrameBase & { readonly kind: 'delta'; readonly text: string })
  | (SourceFrameBase & {
      readonly kind: 'end'
      readonly finalBytes: number
      readonly finalDigest: string
    })
  | (SourceFrameBase & {
      readonly kind: 'abort'
      readonly reason: 'turn-interrupted' | 'turn-failed' | 'source-invalid'
    })

export interface CodexAssistantOutputSourceOptions {
  readonly hostId: HostId
  readonly generation: number
  readonly emit: (event: AssistantOutputEvent) => void
  readonly revoke: () => void
}

/**
 * Validates the proxy's body-bearing side channel. It never reads PTY data and
 * publishes only an admitted Codex thread's agent-message lifecycle.
 */
export class CodexAssistantOutputSource {
  private readonly providerId = asHarnessProviderId('codex')
  private readonly sourceIdentities = new Map<string, string>()
  private sessionId?: string
  private active?: ActiveMessage
  private lastOrder = 0
  private revoked = false
  private disposed = false

  constructor(private readonly options: CodexAssistantOutputSourceOptions) {}

  admitSession(sessionId: string): boolean {
    if (this.disposed || this.revoked || this.sessionId || !identifier(sessionId)) {
      return false
    }
    this.sessionId = sessionId
    return true
  }

  accept(line: string): void {
    if (
      this.disposed ||
      this.revoked ||
      Buffer.byteLength(line, 'utf8') > MAX_SOURCE_RECORD_BYTES
    ) {
      if (!this.disposed && !this.revoked) this.failClosed()
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.failClosed()
      return
    }
    const frame = sourceFrame(value)
    if (!frame) {
      this.failClosed()
      return
    }
    const canonical = JSON.stringify(value)
    const prior = this.sourceIdentities.get(frame.sourceId)
    if (prior !== undefined) {
      if (prior !== canonical) this.failClosed()
      return
    }
    if (frame.order !== this.lastOrder + 1) {
      this.failClosed()
      return
    }
    this.rememberSourceIdentity(frame.sourceId, canonical)
    this.lastOrder = frame.order
    if (!this.sessionId || frame.threadId !== this.sessionId) {
      this.failClosed()
      return
    }
    switch (frame.kind) {
      case 'start':
        this.start(frame)
        break
      case 'delta':
        this.delta(frame)
        break
      case 'end':
        this.end(frame)
        break
      case 'abort':
        this.abort(frame, frame.reason)
        break
    }
  }

  dispose(
    reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'] = 'source-lost',
  ): void {
    if (this.disposed) return
    this.disposed = true
    if (this.active) this.emitAbort(reason)
  }

  private start(frame: SourceFrameBase): void {
    if (this.active) return this.failClosed()
    this.active = {
      sessionId: frame.threadId,
      turnId: frame.turnId,
      messageId: frame.itemId,
      hash: createHash('sha256'),
      bytes: 0,
    }
    this.options.emit({ ...this.eventBase(frame), kind: 'start' })
  }

  private delta(frame: SourceFrameBase & { readonly text: string }): void {
    const active = this.matchingActive(frame)
    const bytes = Buffer.byteLength(frame.text, 'utf8')
    if (
      !active ||
      bytes > MAX_SOURCE_RECORD_BYTES ||
      active.bytes + bytes > MAX_MESSAGE_BYTES
    ) {
      return this.failClosed()
    }
    active.bytes += bytes
    active.hash.update(frame.text, 'utf8')
    this.options.emit({ ...this.eventBase(frame), kind: 'delta', text: frame.text })
  }

  private end(
    frame: SourceFrameBase & {
      readonly finalBytes: number
      readonly finalDigest: string
    },
  ): void {
    const active = this.matchingActive(frame)
    if (
      !active ||
      frame.finalBytes !== active.bytes ||
      frame.finalDigest !== active.hash.digest('hex')
    ) {
      return this.failClosed()
    }
    this.active = undefined
    this.options.emit({ ...this.eventBase(frame), kind: 'end' })
  }

  private abort(
    frame: SourceFrameBase,
    reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'],
  ): void {
    if (!this.matchingActive(frame)) return this.failClosed()
    this.active = undefined
    this.options.emit({ ...this.eventBase(frame), kind: 'abort', reason })
    if (reason === 'source-invalid') {
      this.revoked = true
      this.options.revoke()
    }
  }

  private matchingActive(frame: SourceFrameBase): ActiveMessage | undefined {
    const active = this.active
    return active &&
      active.sessionId === frame.threadId &&
      active.turnId === frame.turnId &&
      active.messageId === frame.itemId
      ? active
      : undefined
  }

  private eventBase(frame: SourceFrameBase) {
    return {
      hostId: this.options.hostId,
      providerId: this.providerId,
      sessionId: frame.threadId,
      turnId: frame.turnId,
      messageId: frame.itemId,
      order: frame.order,
      generation: this.options.generation,
    } as const
  }

  private emitAbort(
    reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'],
  ): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    this.options.emit({
      hostId: this.options.hostId,
      providerId: this.providerId,
      kind: 'abort',
      sessionId: active.sessionId,
      turnId: active.turnId,
      messageId: active.messageId,
      order: this.lastOrder + 1,
      generation: this.options.generation,
      reason,
    })
  }

  private failClosed(): void {
    if (this.revoked || this.disposed) return
    this.revoked = true
    this.emitAbort('source-invalid')
    this.options.revoke()
  }

  private rememberSourceIdentity(sourceId: string, canonical: string): void {
    this.sourceIdentities.set(sourceId, canonical)
    if (this.sourceIdentities.size <= MAX_RETAINED_SOURCE_IDENTITIES) return
    const oldest = this.sourceIdentities.keys().next().value
    if (oldest !== undefined) this.sourceIdentities.delete(oldest)
  }
}

function sourceFrame(value: unknown): SourceFrame | undefined {
  if (!record(value)) return undefined
  if (
    value['revision'] !== SOURCE_REVISION ||
    !identifier(value['sourceId']) ||
    !Number.isSafeInteger(value['order']) ||
    typeof value['order'] !== 'number' ||
    value['order'] <= 0 ||
    !identifier(value['threadId']) ||
    !identifier(value['turnId']) ||
    !identifier(value['itemId'])
  ) {
    return undefined
  }
  const base = {
    revision: SOURCE_REVISION,
    sourceId: value['sourceId'],
    order: value['order'],
    threadId: value['threadId'],
    turnId: value['turnId'],
    itemId: value['itemId'],
  } as const
  switch (value['kind']) {
    case 'start':
      return { ...base, kind: 'start' }
    case 'delta':
      return typeof value['text'] === 'string'
        ? { ...base, kind: 'delta', text: value['text'] }
        : undefined
    case 'end':
      return Number.isSafeInteger(value['finalBytes']) &&
        typeof value['finalBytes'] === 'number' &&
        value['finalBytes'] >= 0 &&
        typeof value['finalDigest'] === 'string' &&
        DIGEST.test(value['finalDigest'])
        ? {
            ...base,
            kind: 'end',
            finalBytes: value['finalBytes'],
            finalDigest: value['finalDigest'],
          }
        : undefined
    case 'abort':
      return value['reason'] === 'turn-interrupted' ||
        value['reason'] === 'turn-failed' ||
        value['reason'] === 'source-invalid'
        ? { ...base, kind: 'abort', reason: value['reason'] }
        : undefined
    default:
      return undefined
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER.test(value)
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
