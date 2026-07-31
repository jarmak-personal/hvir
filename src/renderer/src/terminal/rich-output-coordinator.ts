import type {
  AssistantOutputEvent,
  HarnessProviderCapabilities,
  TerminalIdentityStatus,
} from '../../../shared'
import {
  StreamingMarkdownPresentation,
  type RichMarkdownAbortReason,
  type RichMarkdownLink,
  type RichMarkdownRow,
} from './rich-markdown-policy'

const MAX_RETAINED_MESSAGES = 32
const MAX_RETAINED_BYTES = 2 * 1024 * 1024

export type RichOutputControlState = 'hidden' | 'waiting' | 'available' | 'unavailable'

export interface RichOutputMessage {
  readonly id: string
  readonly turnId: string
  readonly state: 'streaming' | 'ended' | 'aborted'
  readonly rows: readonly RichMarkdownRow[]
  readonly bytes: number
}

export interface RichOutputSnapshot {
  readonly control: RichOutputControlState
  readonly enabled: boolean
  readonly changing: boolean
  readonly messages: readonly RichOutputMessage[]
}

interface ActiveMessage {
  readonly id: string
  readonly turnId: string
  readonly presentation: StreamingMarkdownPresentation
}

export interface RichOutputCoordinatorOptions {
  readonly setMode: (enabled: boolean) => Promise<boolean>
  readonly resolveFileLink: (target: string) => RichMarkdownLink | undefined
  readonly onChange: (snapshot: RichOutputSnapshot) => void
}

/**
 * Memory-only owner for one live terminal's rich-output choice and bounded
 * presentation state. It does not own the PTY, attention, persistence, or UI.
 */
export class RichOutputCoordinator {
  private capability?: HarnessProviderCapabilities['assistantOutput']
  private identityStatus?: TerminalIdentityStatus
  private harnessSessionId?: string
  private availability?: 'available' | 'unavailable'
  private sourceGeneration?: number
  private lastOrder?: number
  private width = 80
  private desiredEnabled = false
  private requestedEnabled?: boolean
  private modeRequest = 0
  private changing = false
  private locallyRevoked = false
  private messages: RichOutputMessage[] = []
  private active?: ActiveMessage
  private disposed = false
  private currentSnapshot: RichOutputSnapshot = {
    control: 'hidden',
    enabled: false,
    changing: false,
    messages: [],
  }

  constructor(private readonly options: RichOutputCoordinatorOptions) {}

  snapshot(): RichOutputSnapshot {
    return this.currentSnapshot
  }

  configure(
    capabilities: HarnessProviderCapabilities,
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus | undefined,
  ): void {
    if (this.disposed) return
    this.capability = capabilities.assistantOutput
    this.harnessSessionId = harnessSessionId
    this.identityStatus = identityStatus
    this.publish()
  }

  setWidth(width: number): void {
    if (Number.isFinite(width)) this.width = Math.max(8, Math.min(500, Math.floor(width)))
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (
      this.disposed ||
      this.changing ||
      this.controlState() !== 'available' ||
      enabled === this.desiredEnabled
    ) {
      return false
    }
    this.changing = true
    this.requestedEnabled = enabled
    const request = ++this.modeRequest
    this.publish()
    let accepted: boolean
    try {
      accepted = await this.options.setMode(enabled)
    } catch {
      accepted = false
    }
    if (this.disposed || request !== this.modeRequest) return false
    this.changing = false
    this.requestedEnabled = undefined
    if (accepted) this.desiredEnabled = enabled
    else this.revokeLocally('source-lost')
    this.publish()
    return accepted
  }

  accept(event: AssistantOutputEvent): void {
    if (this.disposed) return
    if (event.kind === 'availability') {
      this.acceptAvailability(event)
      return
    }
    if (this.capability !== 'structured') return
    if (
      this.locallyRevoked ||
      this.availability !== 'available' ||
      event.generation !== this.sourceGeneration ||
      !this.harnessSessionId ||
      event.sessionId !== this.harnessSessionId ||
      (this.lastOrder === undefined
        ? event.kind !== 'start'
        : event.order !== this.lastOrder + 1)
    ) {
      this.revokeLocally('invalid-lifecycle')
      return
    }
    this.lastOrder = event.order
    switch (event.kind) {
      case 'start':
        if (!this.desiredEnabled && this.requestedEnabled !== true) {
          // Ownership was latched by the proxy before the off boundary reached
          // it. Preserve exactly-once display for this rich-owned item while
          // reasserting that later items remain native.
          void this.options.setMode(false).catch(() => undefined)
        }
        this.start(event)
        break
      case 'delta':
        this.delta(event)
        break
      case 'end':
        this.end(event)
        break
      case 'abort':
        this.abort(event, abortReason(event.reason))
        break
    }
  }

  reset(): void {
    if (this.disposed) return
    this.desiredEnabled = false
    this.requestedEnabled = undefined
    this.modeRequest += 1
    this.changing = false
    this.locallyRevoked = false
    this.availability = undefined
    this.sourceGeneration = undefined
    this.lastOrder = undefined
    this.harnessSessionId = undefined
    this.identityStatus = undefined
    this.messages = []
    this.active = undefined
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.modeRequest += 1
    this.messages = []
    this.active = undefined
  }

  private acceptAvailability(
    event: Extract<AssistantOutputEvent, { kind: 'availability' }>,
  ): void {
    if (this.sourceGeneration !== undefined && event.generation < this.sourceGeneration) {
      return
    }
    if (event.generation !== this.sourceGeneration) {
      this.desiredEnabled = false
      this.requestedEnabled = undefined
      this.modeRequest += 1
      this.changing = false
      this.locallyRevoked = false
      this.lastOrder = undefined
      this.messages = []
      this.active = undefined
      this.sourceGeneration = event.generation
    }
    this.availability = event.state
    if (event.state === 'unavailable') {
      this.desiredEnabled = false
      this.requestedEnabled = undefined
      this.modeRequest += 1
      this.changing = false
      this.finishActive('source-lost')
    }
    this.publish()
  }

  private start(event: Extract<AssistantOutputEvent, { kind: 'start' }>): void {
    if (this.active) return this.revokeLocally('invalid-lifecycle')
    const message: RichOutputMessage = {
      id: event.messageId,
      turnId: event.turnId,
      state: 'streaming',
      rows: [],
      bytes: 0,
    }
    this.messages = [...this.messages, message]
    this.active = {
      id: event.messageId,
      turnId: event.turnId,
      presentation: new StreamingMarkdownPresentation({
        width: this.width,
        resolveFileLink: this.options.resolveFileLink,
      }),
    }
    this.trimRetained()
    this.publish()
  }

  private delta(event: Extract<AssistantOutputEvent, { kind: 'delta' }>): void {
    const active = this.matchingActive(event)
    if (!active) return this.revokeLocally('invalid-lifecycle')
    const update = active.presentation.append(event.text)
    this.updateActive(update.rows, utf8Bytes(event.text), update.state)
    if (update.state === 'aborted') this.revokeLocally(update.reason ?? 'source-lost')
    else this.publish()
  }

  private end(event: Extract<AssistantOutputEvent, { kind: 'end' }>): void {
    const active = this.matchingActive(event)
    if (!active) return this.revokeLocally('invalid-lifecycle')
    const update = active.presentation.end()
    this.updateActive(update.rows, 0, update.state)
    this.active = undefined
    this.trimRetained()
    this.publish()
  }

  private abort(
    event: Extract<AssistantOutputEvent, { kind: 'abort' }>,
    reason: RichMarkdownAbortReason,
  ): void {
    if (!this.matchingActive(event)) return this.revokeLocally('invalid-lifecycle')
    this.finishActive(reason)
    this.publish()
  }

  private finishActive(reason: RichMarkdownAbortReason): void {
    const active = this.active
    if (!active) return
    const update = active.presentation.abort(reason)
    this.updateActive(update.rows, 0, update.state)
    this.active = undefined
    this.trimRetained()
  }

  private matchingActive(
    event: Extract<AssistantOutputEvent, { kind: 'delta' | 'end' | 'abort' }>,
  ): ActiveMessage | undefined {
    const active = this.active
    return active && active.id === event.messageId && active.turnId === event.turnId
      ? active
      : undefined
  }

  private updateActive(
    rows: readonly RichMarkdownRow[],
    bytes: number,
    state: RichOutputMessage['state'],
  ): void {
    const active = this.active
    if (!active) return
    this.messages = this.messages.map((message) =>
      message.id === active.id
        ? {
            ...message,
            state,
            rows: rows.length ? [...message.rows, ...rows] : message.rows,
            bytes: message.bytes + bytes,
          }
        : message,
    )
  }

  private revokeLocally(reason: RichMarkdownAbortReason): void {
    if (this.locallyRevoked || this.disposed) return
    this.locallyRevoked = true
    this.desiredEnabled = false
    this.requestedEnabled = undefined
    this.modeRequest += 1
    this.changing = false
    this.finishActive(reason)
    void this.options.setMode(false).catch(() => undefined)
    this.publish()
  }

  private trimRetained(): void {
    while (
      this.messages.length > MAX_RETAINED_MESSAGES ||
      retainedBytes(this.messages) > MAX_RETAINED_BYTES
    ) {
      const removable = this.messages.findIndex(
        (message) => message.id !== this.active?.id,
      )
      if (removable < 0) return
      this.messages = this.messages.filter((_message, index) => index !== removable)
    }
  }

  private controlState(): RichOutputControlState {
    if (this.capability !== 'structured') return 'hidden'
    if (this.locallyRevoked || this.availability === 'unavailable') {
      return 'unavailable'
    }
    return this.availability === 'available' &&
      this.identityStatus === 'identified' &&
      Boolean(this.harnessSessionId)
      ? 'available'
      : 'waiting'
  }

  private publish(): void {
    const next: RichOutputSnapshot = {
      control: this.controlState(),
      enabled: this.desiredEnabled,
      changing: this.changing,
      messages: this.messages,
    }
    if (
      next.control === this.currentSnapshot.control &&
      next.enabled === this.currentSnapshot.enabled &&
      next.changing === this.currentSnapshot.changing &&
      next.messages === this.currentSnapshot.messages
    ) {
      return
    }
    this.currentSnapshot = next
    this.options.onChange(next)
  }
}

function abortReason(
  reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'],
): RichMarkdownAbortReason {
  return reason === 'source-invalid' ? 'invalid-lifecycle' : 'source-lost'
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function retainedBytes(messages: readonly RichOutputMessage[]): number {
  return messages.reduce((total, message) => total + message.bytes, 0)
}
