import {
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  isDiagnosticOpaqueId,
  type IpcInvokeChannel,
  type IpcSendChannel,
} from '../../shared'

export type DiagnosticHostKind = 'local' | 'ssh'
export type DiagnosticLaunchMode = 'fresh' | 'resume'
export type ApplicationDiagnosticKind =
  | 'application-starting'
  | 'application-ready'
  | 'application-shutdown-starting'
  | 'application-shutdown-completed'
  | 'application-startup-failed'
  | 'application-shutdown-failed'

export type DiagnosticIpcChannel = IpcInvokeChannel | IpcSendChannel

export type RuntimeDiagnosticEvent =
  | { readonly kind: ApplicationDiagnosticKind }
  | {
      readonly kind: 'pty-spawned' | 'pty-spawn-failed'
      readonly hostKind: DiagnosticHostKind
      readonly launchMode: DiagnosticLaunchMode
    }
  | {
      readonly kind: 'pty-exited'
      readonly hostKind: DiagnosticHostKind
      readonly launchMode: DiagnosticLaunchMode
      readonly exitKind: 'clean' | 'error' | 'signal'
      readonly lifetime: 'under-30s' | 'under-5m' | '5m-or-more'
    }
  | {
      readonly kind: 'terminal-session-registry-load-failed'
      readonly reason: 'read-failed' | 'invalid-json' | 'invalid-schema'
    }
  | { readonly kind: 'terminal-session-registry-persist-failed' }
  | {
      readonly kind: 'host-control-failed'
      readonly operation: 'connect' | 'disconnect'
      readonly hostKind: DiagnosticHostKind
    }
  | {
      readonly kind: 'ipc-contract-rejected'
      readonly channel: DiagnosticIpcChannel
      readonly outcome: 'non-main-frame' | 'renderer-revoked'
      readonly timing: 'under-1ms' | 'under-10ms' | '10ms-or-more'
    }
  | {
      readonly kind: 'react-render-contained'
      readonly ownerId: number
      readonly ownerGeneration: number
      readonly occurrenceId: string
    }

export type DiagnosticSource =
  | 'application'
  | 'pty-supervisor'
  | 'terminal-session-registry'
  | 'project-coordinator'
  | 'ipc-authority-router'
  | 'renderer-error-boundary'

interface StoredDiagnosticEventBase {
  readonly [key: string]: unknown
  readonly version: 1
  readonly occurredAt: string
  readonly kind: RuntimeDiagnosticEvent['kind']
  readonly owner: DiagnosticSource
  readonly ownerGeneration: number
  readonly severity: 'info' | 'warning' | 'error'
  readonly correlation: string
}

export type StoredDiagnosticEvent = StoredDiagnosticEventBase & Record<string, unknown>

export interface DiagnosticEventContext {
  readonly occurredAtMs: number
  readonly correlation: string
}

export function materializeDiagnosticEvent(
  event: RuntimeDiagnosticEvent,
  context: DiagnosticEventContext,
): StoredDiagnosticEvent | undefined {
  const base: StoredDiagnosticEventBase = {
    version: 1,
    occurredAt: new Date(context.occurredAtMs).toISOString(),
    kind: event.kind,
    owner: diagnosticSource(event.kind),
    ownerGeneration: event.kind === 'react-render-contained' ? event.ownerGeneration : 1,
    severity: severityFor(event.kind),
    correlation: context.correlation,
  }
  let stored: StoredDiagnosticEvent
  switch (event.kind) {
    case 'pty-spawned':
    case 'pty-spawn-failed':
      stored = { ...base, hostKind: event.hostKind, launchMode: event.launchMode }
      break
    case 'pty-exited':
      stored = {
        ...base,
        hostKind: event.hostKind,
        launchMode: event.launchMode,
        exitKind: event.exitKind,
        lifetime: event.lifetime,
      }
      break
    case 'terminal-session-registry-load-failed':
      stored = { ...base, reason: event.reason }
      break
    case 'host-control-failed':
      stored = { ...base, operation: event.operation, hostKind: event.hostKind }
      break
    case 'ipc-contract-rejected':
      stored = {
        ...base,
        channel: event.channel,
        outcome: event.outcome,
        timing: event.timing,
      }
      break
    case 'react-render-contained':
      stored = {
        ...base,
        ownerId: event.ownerId,
        occurrenceId: event.occurrenceId,
      }
      break
    default:
      stored = base
  }
  return isStoredDiagnosticEvent(stored) ? stored : undefined
}

export function serializeStoredDiagnosticEvent(
  event: StoredDiagnosticEvent,
): string | undefined {
  return isStoredDiagnosticEvent(event) ? `${JSON.stringify(event)}\n` : undefined
}

export function parseStoredDiagnosticEvent(
  value: unknown,
): StoredDiagnosticEvent | undefined {
  return isStoredDiagnosticEvent(value) ? value : undefined
}

export function diagnosticSource(kind: RuntimeDiagnosticEvent['kind']): DiagnosticSource {
  if (kind.startsWith('application-')) return 'application'
  if (kind.startsWith('pty-')) return 'pty-supervisor'
  if (kind.startsWith('terminal-session-registry-')) {
    return 'terminal-session-registry'
  }
  if (kind === 'host-control-failed') return 'project-coordinator'
  if (kind === 'ipc-contract-rejected') return 'ipc-authority-router'
  return 'renderer-error-boundary'
}

function severityFor(
  kind: RuntimeDiagnosticEvent['kind'],
): StoredDiagnosticEventBase['severity'] {
  if (kind === 'ipc-contract-rejected') return 'warning'
  if (kind === 'react-render-contained' || kind.endsWith('-failed')) return 'error'
  return 'info'
}

function isStoredDiagnosticEvent(value: unknown): value is StoredDiagnosticEvent {
  if (!isRecord(value) || value['version'] !== 1) return false
  const kind = value['kind']
  if (
    typeof kind !== 'string' ||
    !DIAGNOSTIC_KINDS.has(kind as RuntimeDiagnosticEvent['kind']) ||
    value['owner'] !== diagnosticSource(kind as RuntimeDiagnosticEvent['kind']) ||
    value['severity'] !== severityFor(kind as RuntimeDiagnosticEvent['kind']) ||
    !Number.isSafeInteger(value['ownerGeneration']) ||
    Number(value['ownerGeneration']) < 1 ||
    !isIsoTime(value['occurredAt']) ||
    !isDiagnosticOpaqueId(value['correlation'])
  ) {
    return false
  }
  const keys = new Set(Object.keys(value))
  for (const common of COMMON_KEYS) keys.delete(common)
  if (kind === 'pty-spawned' || kind === 'pty-spawn-failed') {
    return exactFields(keys, ['hostKind', 'launchMode']) && isPtyFields(value)
  }
  if (kind === 'pty-exited') {
    return (
      exactFields(keys, ['hostKind', 'launchMode', 'exitKind', 'lifetime']) &&
      isPtyFields(value) &&
      ['clean', 'error', 'signal'].includes(String(value['exitKind'])) &&
      ['under-30s', 'under-5m', '5m-or-more'].includes(String(value['lifetime']))
    )
  }
  if (kind === 'terminal-session-registry-load-failed') {
    return (
      exactFields(keys, ['reason']) &&
      ['read-failed', 'invalid-json', 'invalid-schema'].includes(String(value['reason']))
    )
  }
  if (kind === 'host-control-failed') {
    return (
      exactFields(keys, ['operation', 'hostKind']) &&
      ['connect', 'disconnect'].includes(String(value['operation'])) &&
      isHostKind(value['hostKind'])
    )
  }
  if (kind === 'ipc-contract-rejected') {
    return (
      exactFields(keys, ['channel', 'outcome', 'timing']) &&
      isIpcChannel(value['channel']) &&
      ['non-main-frame', 'renderer-revoked'].includes(String(value['outcome'])) &&
      ['under-1ms', 'under-10ms', '10ms-or-more'].includes(String(value['timing']))
    )
  }
  if (kind === 'react-render-contained') {
    return (
      exactFields(keys, ['ownerId', 'occurrenceId']) &&
      Number.isSafeInteger(value['ownerId']) &&
      Number(value['ownerId']) > 0 &&
      isDiagnosticOpaqueId(value['occurrenceId'])
    )
  }
  return value['ownerGeneration'] === 1 && keys.size === 0
}

const COMMON_KEYS = [
  'version',
  'occurredAt',
  'kind',
  'owner',
  'ownerGeneration',
  'severity',
  'correlation',
] as const

const DIAGNOSTIC_KINDS = new Set<RuntimeDiagnosticEvent['kind']>([
  'application-starting',
  'application-ready',
  'application-shutdown-starting',
  'application-shutdown-completed',
  'application-startup-failed',
  'application-shutdown-failed',
  'pty-spawned',
  'pty-spawn-failed',
  'pty-exited',
  'terminal-session-registry-load-failed',
  'terminal-session-registry-persist-failed',
  'host-control-failed',
  'ipc-contract-rejected',
  'react-render-contained',
])

function exactFields(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return actual.size === expected.length && expected.every((key) => actual.has(key))
}

function isPtyFields(value: Record<string, unknown>): boolean {
  return (
    isHostKind(value['hostKind']) &&
    ['fresh', 'resume'].includes(String(value['launchMode']))
  )
}

function isHostKind(value: unknown): value is DiagnosticHostKind {
  return value === 'local' || value === 'ssh'
}

function isIpcChannel(value: unknown): value is DiagnosticIpcChannel {
  return (
    typeof value === 'string' &&
    ([...INVOKE_CHANNELS, ...SEND_CHANNELS] as readonly string[]).includes(value)
  )
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
