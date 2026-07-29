import { isDiagnosticOpaqueId } from './diagnostics'

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

export type DiagnosticReportOwner =
  | 'application'
  | 'pty-supervisor'
  | 'terminal-session-registry'
  | 'project-coordinator'
  | 'ipc-authority-router'
  | 'renderer-error-boundary'
  | 'window-manager'

export type DiagnosticReportLifetimeScope = 'preceding-lifetime' | 'current-lifetime'

interface DiagnosticReportEventBase {
  readonly scope: DiagnosticReportLifetimeScope
  readonly kind: DiagnosticReportEventKind
  readonly owner: DiagnosticReportOwner
  readonly ownerGeneration: number
  readonly severity: 'info' | 'warning' | 'error'
  readonly occurredAt: string
  readonly correlation: string
}

export type DiagnosticReportEvent = DiagnosticReportEventBase

export const DIAGNOSTIC_REPORT_OWNERS: readonly DiagnosticReportOwner[] = [
  'application',
  'pty-supervisor',
  'terminal-session-registry',
  'project-coordinator',
  'ipc-authority-router',
  'renderer-error-boundary',
  'window-manager',
]

export function isDiagnosticReportEvent(value: unknown): value is DiagnosticReportEvent {
  if (!isRecord(value)) return false
  const common =
    REPORT_EVENT_SCOPES.includes(value.scope as DiagnosticReportLifetimeScope) &&
    REPORT_EVENT_KINDS.includes(value.kind as DiagnosticReportEventKind) &&
    DIAGNOSTIC_REPORT_OWNERS.includes(value.owner as DiagnosticReportOwner) &&
    isPositiveSafeInteger(value.ownerGeneration) &&
    ['info', 'warning', 'error'].includes(String(value.severity)) &&
    isIsoTime(value.occurredAt) &&
    isDiagnosticOpaqueId(value.correlation)
  if (!common) return false
  return exactKeys(value, [
    'scope',
    'kind',
    'owner',
    'ownerGeneration',
    'severity',
    'occurredAt',
    'correlation',
  ])
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
]

const REPORT_EVENT_SCOPES: readonly DiagnosticReportLifetimeScope[] = [
  'preceding-lifetime',
  'current-lifetime',
]
