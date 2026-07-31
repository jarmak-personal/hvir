import type { HarnessProviderId } from './harness-provider'
import type { HostId } from './host-path'

export type AssistantOutputAvailability = 'available' | 'unavailable'

interface AssistantOutputEventBase {
  readonly hostId: HostId
  readonly providerId: HarnessProviderId
  /** One source-observer lifetime. Events from older generations are stale. */
  readonly generation: number
}

interface AssistantOutputMessageEventBase extends AssistantOutputEventBase {
  readonly sessionId: string
  readonly turnId: string
  readonly messageId: string
  /** Strictly increasing within one observer generation. */
  readonly order: number
}

/** Bounded provider output safe to route across typed IPC. */
export type AssistantOutputEvent =
  | (AssistantOutputEventBase & {
      readonly kind: 'availability'
      readonly state: AssistantOutputAvailability
    })
  | (AssistantOutputMessageEventBase & { readonly kind: 'start' })
  | (AssistantOutputMessageEventBase & {
      readonly kind: 'delta'
      readonly text: string
    })
  | (AssistantOutputMessageEventBase & { readonly kind: 'end' })
  | (AssistantOutputEventBase & {
      readonly kind: 'abort'
      readonly sessionId: string
      readonly turnId: string
      readonly messageId?: string
      readonly order: number
      readonly reason:
        | 'source-invalid'
        | 'source-lost'
        | 'turn-interrupted'
        | 'turn-failed'
        | 'session-exit'
        | 'renderer-revoked'
    })

export interface SetAssistantOutputModeRequest {
  readonly id: string
  readonly enabled: boolean
}
