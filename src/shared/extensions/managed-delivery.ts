import type { HostPath } from '../host-path'

export const DELIVERY_LIMITS = {
  files: 512,
  depth: 16,
  fileBytes: 2 * 1024 * 1024,
  payloadBytes: 32 * 1024 * 1024,
  captures: 2,
  captureMs: 300_000,
  operations: 64,
  records: 128,
  retainedBytes: 256 * 1024 * 1024,
  stateBytes: 4 * 1024 * 1024,
  domainBytes: 4096,
  domainTotalBytes: 256 * 1024,
  concurrent: 2,
  deadlineMs: 180_000,
  cleanupMs: 30_000,
  pageRows: 16,
} as const

export interface DeliveryTreeEntry {
  readonly path: string
  readonly type: 'file' | 'dir'
  readonly mode: number
  readonly size: number
  readonly sha256?: string
}
export interface ExtensionDeliveryRecord {
  readonly id: string
  readonly operation: string
  readonly installation: string
  readonly workspace: string
  readonly root: HostPath
  readonly target: HostPath
  readonly sourceVersion: string
  readonly identity: string
  readonly fingerprint: string
  readonly files: number
  readonly bytes: number
}
export type DeliveryOutcome = 'refused' | 'completed' | 'conflicted' | 'uncertain'
export interface ExtensionDeliveryResult {
  readonly operation?: string
  readonly outcome: DeliveryOutcome
  readonly record?: ExtensionDeliveryRecord
  readonly reason?: string
  readonly staging?: HostPath
  readonly preserved?: HostPath
}

export interface DeliveryRecoveryEntry {
  readonly workspace: string
  readonly root: HostPath
  readonly id: string
  readonly installation: string
  readonly phase: string
  readonly target: HostPath
  readonly staging: HostPath
  readonly preserved: HostPath
  readonly outcome: string
}

export interface DeliveryRecoveryReply {
  readonly token?: string
  readonly operation?: string
  readonly installation?: string
  readonly phase?: string
  readonly completion?: string
  readonly objects?: readonly {
    readonly path: HostPath
    readonly state: string
    readonly identity?: string
    readonly fingerprint?: string
    readonly recordedIdentity?: string
  }[]
  readonly resolution?: string
  readonly outcome?: string
  readonly files?: string
  readonly removed?: number
  readonly target?: string
  readonly reason?: string
  readonly replayed?: boolean
}
