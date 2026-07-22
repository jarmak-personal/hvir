import { isDiagnosticOpaqueId } from './diagnostics'
import { RENDERER_RESPONSIVENESS_MAX_DROPPED } from './renderer-responsiveness'

export type DiagnosticReportEventKind =
  | 'application-starting'
  | 'application-ready'
  | 'application-shutdown-starting'
  | 'application-shutdown-completed'
  | 'application-startup-failed'
  | 'application-shutdown-failed'
  | 'pty-spawned'
  | 'pty-spawn-failed'
  | 'pty-exited'
  | 'terminal-session-registry-load-failed'
  | 'terminal-session-registry-persist-failed'
  | 'host-control-failed'
  | 'ipc-contract-rejected'
  | 'react-render-contained'
  | 'main-document-load-failed'
  | 'renderer-process-exited'
  | 'renderer-unresponsive'
  | 'workbench-health-recovered'
  | 'renderer-responsiveness-episode'

export type DiagnosticReportOwner =
  | 'application'
  | 'pty-supervisor'
  | 'terminal-session-registry'
  | 'project-coordinator'
  | 'ipc-authority-router'
  | 'renderer-error-boundary'
  | 'renderer-responsiveness'
  | 'window-manager'

interface DiagnosticReportEventBase {
  readonly kind: Exclude<DiagnosticReportEventKind, 'renderer-responsiveness-episode'>
  readonly owner: DiagnosticReportOwner
  readonly ownerGeneration: number
  readonly severity: 'info' | 'warning' | 'error'
  readonly occurredAt: string
  readonly correlation: string
}

export type DiagnosticReportEvent =
  | DiagnosticReportEventBase
  | {
      readonly kind: 'renderer-responsiveness-episode'
      readonly owner: 'renderer-responsiveness'
      readonly ownerGeneration: number
      readonly severity: 'info'
      readonly occurredAt: string
      readonly correlation: string
      readonly sessionId: string
      readonly count: number
      readonly drop: number
      readonly timing: '100-199ms' | '200-499ms' | '500ms-or-more'
      readonly classification: 'input-paint-delay' | 'unattributed'
      readonly confounder: 'none' | 'runtime-or-environment'
      readonly firstAt: string
      readonly lastAt: string
      readonly resolution:
        | 'window-rollover'
        | 'user-stop'
        | 'timeout'
        | 'backgrounded'
        | 'api-unavailable'
        | 'renderer-revoked'
    }

export const DIAGNOSTIC_REPORT_OWNERS: readonly DiagnosticReportOwner[] = [
  'application',
  'pty-supervisor',
  'terminal-session-registry',
  'project-coordinator',
  'ipc-authority-router',
  'renderer-error-boundary',
  'renderer-responsiveness',
  'window-manager',
]

export function isDiagnosticReportEvent(value: unknown): value is DiagnosticReportEvent {
  if (!isRecord(value)) return false
  const common =
    REPORT_EVENT_KINDS.includes(value.kind as DiagnosticReportEventKind) &&
    DIAGNOSTIC_REPORT_OWNERS.includes(value.owner as DiagnosticReportOwner) &&
    isPositiveSafeInteger(value.ownerGeneration) &&
    ['info', 'warning', 'error'].includes(String(value.severity)) &&
    isIsoTime(value.occurredAt) &&
    isDiagnosticOpaqueId(value.correlation)
  if (!common) return false
  if (value.kind !== 'renderer-responsiveness-episode') {
    return exactKeys(value, [
      'kind',
      'owner',
      'ownerGeneration',
      'severity',
      'occurredAt',
      'correlation',
    ])
  }
  return (
    exactKeys(value, [
      'kind',
      'owner',
      'ownerGeneration',
      'severity',
      'occurredAt',
      'correlation',
      'sessionId',
      'count',
      'drop',
      'timing',
      'classification',
      'confounder',
      'firstAt',
      'lastAt',
      'resolution',
    ]) &&
    value.owner === 'renderer-responsiveness' &&
    value.severity === 'info' &&
    isDiagnosticOpaqueId(value.sessionId) &&
    isPositiveSafeInteger(value.count) &&
    isSafeCount(value.drop) &&
    value.drop <= RENDERER_RESPONSIVENESS_MAX_DROPPED &&
    ['100-199ms', '200-499ms', '500ms-or-more'].includes(String(value.timing)) &&
    ['input-paint-delay', 'unattributed'].includes(String(value.classification)) &&
    ['none', 'runtime-or-environment'].includes(String(value.confounder)) &&
    isIsoTime(value.firstAt) &&
    isIsoTime(value.lastAt) &&
    Date.parse(String(value.firstAt)) <= Date.parse(String(value.lastAt)) &&
    [
      'window-rollover',
      'user-stop',
      'timeout',
      'backgrounded',
      'api-unavailable',
      'renderer-revoked',
    ].includes(String(value.resolution)) &&
    (value.classification === 'input-paint-delay'
      ? value.confounder === 'none'
      : value.confounder === 'runtime-or-environment')
  )
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeCount(value) && value > 0
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REPORT_EVENT_KINDS: readonly DiagnosticReportEventKind[] = [
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
  'main-document-load-failed',
  'renderer-process-exited',
  'renderer-unresponsive',
  'workbench-health-recovered',
  'renderer-responsiveness-episode',
]
