import { isDiagnosticOpaqueId } from './diagnostics'

export const WORKBENCH_HEALTH_VERSION = 1
export const MAX_WORKBENCH_HEALTH_ITEMS = 64
export const MAX_WORKBENCH_HEALTH_SNAPSHOT_BYTES = 128 * 1024

export type WorkbenchHealthKind =
  | 'react-render-contained'
  | 'main-document-load-failed'
  | 'renderer-process-exited'
  | 'renderer-unresponsive'

export type WorkbenchHealthClassification =
  | 'contained'
  | 'not-found'
  | 'connection'
  | 'certificate'
  | 'other'
  | 'crashed'
  | 'killed'
  | 'oom'
  | 'integrity'
  | 'launch'
  | 'unresponsive'

export type WorkbenchHealthRecoveryOutcome =
  | 'document-loaded'
  | 'renderer-reloaded'
  | 'responsive'
  | 'wait-selected'
  | 'reload-selected'
  | 'renderer-exited'
  | 'window-closed'

export interface WorkbenchHealthItem {
  readonly occurrenceId: string
  readonly kind: WorkbenchHealthKind
  readonly classification: WorkbenchHealthClassification
  readonly owner: 'renderer-error-boundary' | 'window-manager'
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly severity: 'degraded' | 'critical'
  readonly state: 'open' | 'acknowledged' | 'resolved'
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  readonly count: number
  readonly correlation: string
  readonly recoveryOutcome?: WorkbenchHealthRecoveryOutcome
}

export interface WorkbenchHealthSnapshot {
  readonly version: typeof WORKBENCH_HEALTH_VERSION
  readonly evidence: 'durable' | 'memory-only' | 'unavailable'
  readonly items: readonly WorkbenchHealthItem[]
  readonly dropped: number
}

export function isWorkbenchHealthSnapshot(
  value: unknown,
): value is WorkbenchHealthSnapshot {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['version', 'evidence', 'items', 'dropped']) ||
    value['version'] !== WORKBENCH_HEALTH_VERSION ||
    !['durable', 'memory-only', 'unavailable'].includes(String(value['evidence'])) ||
    !isSafeCount(value['dropped']) ||
    !Array.isArray(value['items']) ||
    value['items'].length > MAX_WORKBENCH_HEALTH_ITEMS ||
    !value['items'].every(isWorkbenchHealthItem)
  ) {
    return false
  }
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MAX_WORKBENCH_HEALTH_SNAPSHOT_BYTES
  )
}

function isWorkbenchHealthItem(value: unknown): value is WorkbenchHealthItem {
  if (!isRecord(value)) return false
  const expected = [
    'occurrenceId',
    'kind',
    'classification',
    'owner',
    'ownerId',
    'ownerGeneration',
    'severity',
    'state',
    'firstObservedAt',
    'lastObservedAt',
    'count',
    'correlation',
    ...(value['recoveryOutcome'] === undefined ? [] : ['recoveryOutcome']),
  ]
  return (
    exactKeys(value, expected) &&
    isDiagnosticOpaqueId(value['occurrenceId']) &&
    isKindClassificationAndOwner(
      value['kind'],
      value['classification'],
      value['owner'],
    ) &&
    isPositiveSafeInteger(value['ownerId']) &&
    isPositiveSafeInteger(value['ownerGeneration']) &&
    isSeverityForKind(value['kind'], value['severity']) &&
    ['open', 'acknowledged', 'resolved'].includes(String(value['state'])) &&
    isIsoTime(value['firstObservedAt']) &&
    isIsoTime(value['lastObservedAt']) &&
    isSafeCount(value['count']) &&
    Number(value['count']) > 0 &&
    isDiagnosticOpaqueId(value['correlation']) &&
    isRecoveryState(value['kind'], value['state'], value['recoveryOutcome'])
  )
}

export function isWorkbenchHealthRecoveryOutcome(
  value: unknown,
): value is WorkbenchHealthRecoveryOutcome {
  return (
    typeof value === 'string' &&
    [
      'document-loaded',
      'renderer-reloaded',
      'responsive',
      'wait-selected',
      'reload-selected',
      'renderer-exited',
      'window-closed',
    ].some((candidate) => candidate === value)
  )
}

function isKindClassificationAndOwner(
  kind: unknown,
  classification: unknown,
  owner: unknown,
): boolean {
  if (kind === 'react-render-contained') {
    return classification === 'contained' && owner === 'renderer-error-boundary'
  }
  if (owner !== 'window-manager') return false
  if (kind === 'main-document-load-failed') {
    return ['not-found', 'connection', 'certificate', 'other'].includes(
      String(classification),
    )
  }
  if (kind === 'renderer-process-exited') {
    return ['crashed', 'killed', 'oom', 'integrity', 'launch', 'other'].includes(
      String(classification),
    )
  }
  return kind === 'renderer-unresponsive' && classification === 'unresponsive'
}

function isSeverityForKind(kind: unknown, severity: unknown): boolean {
  if (kind === 'renderer-process-exited') return severity === 'critical'
  if (kind === 'main-document-load-failed') {
    return severity === 'critical' || severity === 'degraded'
  }
  return severity === 'degraded'
}

function isRecoveryState(kind: unknown, state: unknown, outcome: unknown): boolean {
  if (state === 'open') return outcome === undefined
  if (state === 'acknowledged')
    return outcome === undefined || outcome === 'wait-selected'
  if (state !== 'resolved' || !isWorkbenchHealthRecoveryOutcome(outcome)) return false
  if (kind === 'main-document-load-failed') {
    return ['document-loaded', 'renderer-reloaded', 'window-closed'].includes(outcome)
  }
  if (kind === 'renderer-unresponsive') {
    return ['responsive', 'reload-selected', 'renderer-exited', 'window-closed'].includes(
      outcome,
    )
  }
  return outcome === 'renderer-reloaded' || outcome === 'window-closed'
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeCount(value) && value > 0
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
