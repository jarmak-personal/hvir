import { isDiagnosticOpaqueId } from './diagnostics'

export const RENDERER_RESPONSIVENESS_VERSION = 1
export const RENDERER_RESPONSIVENESS_MAX_DURATION_MS = 15 * 60 * 1_000
export const RENDERER_RESPONSIVENESS_WINDOW_MS = 30 * 1_000
export const RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS = 512
export const RENDERER_RESPONSIVENESS_MAX_AGGREGATES = 30
export const RENDERER_RESPONSIVENESS_MAX_DROPPED = 9_999
export const RENDERER_RESPONSIVENESS_BATCH_EVENTS = 16
export const RENDERER_RESPONSIVENESS_QUEUE_EVENTS = 64
export const RENDERER_RESPONSIVENESS_BATCH_BYTES = 16 * 1024
export const RENDERER_RESPONSIVENESS_QUEUE_BYTES = 64 * 1024

export type ResponsivenessTiming = '100-199ms' | '200-499ms' | '500ms-or-more'
export type ResponsivenessClassification = 'input-paint-delay' | 'unattributed'
export type ResponsivenessConfounder = 'none' | 'runtime-or-environment'
export type ResponsivenessStopReason =
  'user-stop' | 'timeout' | 'backgrounded' | 'api-unavailable' | 'renderer-revoked'

export interface ResponsivenessObservation {
  readonly version: typeof RENDERER_RESPONSIVENESS_VERSION
  readonly diagnosticSessionId: string
  readonly observationCount: number
  readonly dropped: number
  readonly timing: ResponsivenessTiming
  readonly classification: ResponsivenessClassification
  readonly confounder: ResponsivenessConfounder
}

export interface ResponsivenessObservationBatch {
  readonly version: typeof RENDERER_RESPONSIVENESS_VERSION
  readonly diagnosticSessionId: string
  readonly observations: readonly ResponsivenessObservation[]
  readonly dropped: {
    readonly invalid: number
    readonly queue: number
    readonly rate: number
  }
}

export interface StopResponsivenessDiagnosticsRequest {
  readonly diagnosticSessionId: string
  readonly reason: Exclude<ResponsivenessStopReason, 'timeout' | 'renderer-revoked'>
}

export interface DeleteResponsivenessDiagnosticsRequest {
  readonly diagnosticSessionId: string
}

interface ResponsivenessDiagnosticsStateBase {
  readonly version: typeof RENDERER_RESPONSIVENESS_VERSION
  readonly available: boolean
}

export type ResponsivenessDiagnosticsState =
  | (ResponsivenessDiagnosticsStateBase & {
      readonly available: false
      readonly status: 'unavailable'
      readonly reason: 'packaged-build'
    })
  | (ResponsivenessDiagnosticsStateBase & {
      readonly available: true
      readonly status: 'idle'
    })
  | (ResponsivenessDiagnosticsStateBase & {
      readonly available: true
      readonly status: 'active'
      readonly diagnosticSessionId: string
      readonly startedAt: string
      readonly expiresAt: string
      readonly observationCount: number
      readonly aggregateCount: number
      readonly dropped: number
    })
  | (ResponsivenessDiagnosticsStateBase & {
      readonly available: true
      readonly status: 'complete'
      readonly diagnosticSessionId: string
      readonly stoppedAt: string
      readonly stopReason: ResponsivenessStopReason
      readonly observationCount: number
      readonly aggregateCount: number
      readonly dropped: number
    })

export function isResponsivenessObservation(
  value: unknown,
): value is ResponsivenessObservation {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'version',
      'diagnosticSessionId',
      'observationCount',
      'dropped',
      'timing',
      'classification',
      'confounder',
    ]) &&
    value.version === RENDERER_RESPONSIVENESS_VERSION &&
    isDiagnosticOpaqueId(value.diagnosticSessionId) &&
    isPositiveSafeInteger(value.observationCount) &&
    value.observationCount <= RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS &&
    isSafeCount(value.dropped) &&
    value.dropped <= RENDERER_RESPONSIVENESS_MAX_DROPPED &&
    isTiming(value.timing) &&
    isClassification(value.classification) &&
    isConfounder(value.confounder) &&
    (value.classification === 'input-paint-delay'
      ? value.confounder === 'none'
      : value.confounder === 'runtime-or-environment')
  )
}

export function isResponsivenessObservationBatch(
  value: unknown,
): value is ResponsivenessObservationBatch {
  return (
    isRecord(value) &&
    exactKeys(value, ['version', 'diagnosticSessionId', 'observations', 'dropped']) &&
    value.version === RENDERER_RESPONSIVENESS_VERSION &&
    isDiagnosticOpaqueId(value.diagnosticSessionId) &&
    Array.isArray(value.observations) &&
    value.observations.length <= RENDERER_RESPONSIVENESS_BATCH_EVENTS &&
    value.observations.every(
      (observation) =>
        isResponsivenessObservation(observation) &&
        observation.diagnosticSessionId === value.diagnosticSessionId,
    ) &&
    isRecord(value.dropped) &&
    exactKeys(value.dropped, ['invalid', 'queue', 'rate']) &&
    Object.values(value.dropped).every(isSafeCount)
  )
}

export function isStopResponsivenessDiagnosticsRequest(
  value: unknown,
): value is StopResponsivenessDiagnosticsRequest {
  return (
    isRecord(value) &&
    exactKeys(value, ['diagnosticSessionId', 'reason']) &&
    isDiagnosticOpaqueId(value.diagnosticSessionId) &&
    ['user-stop', 'backgrounded', 'api-unavailable'].includes(String(value.reason))
  )
}

export function isDeleteResponsivenessDiagnosticsRequest(
  value: unknown,
): value is DeleteResponsivenessDiagnosticsRequest {
  return (
    isRecord(value) &&
    exactKeys(value, ['diagnosticSessionId']) &&
    isDiagnosticOpaqueId(value.diagnosticSessionId)
  )
}

export function isResponsivenessDiagnosticsState(
  value: unknown,
): value is ResponsivenessDiagnosticsState {
  if (
    !isRecord(value) ||
    value.version !== RENDERER_RESPONSIVENESS_VERSION ||
    typeof value.available !== 'boolean' ||
    typeof value.status !== 'string'
  ) {
    return false
  }
  if (value.status === 'unavailable') {
    return (
      exactKeys(value, ['version', 'available', 'status', 'reason']) &&
      value.available === false &&
      value.reason === 'packaged-build'
    )
  }
  if (value.status === 'idle') {
    return exactKeys(value, ['version', 'available', 'status']) && value.available
  }
  const common =
    value.available &&
    isDiagnosticOpaqueId(value.diagnosticSessionId) &&
    isSafeCount(value.observationCount) &&
    value.observationCount <= RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS &&
    isSafeCount(value.aggregateCount) &&
    value.aggregateCount <= RENDERER_RESPONSIVENESS_MAX_AGGREGATES &&
    isSafeCount(value.dropped) &&
    value.dropped <= RENDERER_RESPONSIVENESS_MAX_DROPPED
  if (value.status === 'active') {
    return (
      common &&
      exactKeys(value, [
        'version',
        'available',
        'status',
        'diagnosticSessionId',
        'startedAt',
        'expiresAt',
        'observationCount',
        'aggregateCount',
        'dropped',
      ]) &&
      isIsoTime(value.startedAt) &&
      isIsoTime(value.expiresAt)
    )
  }
  return (
    value.status === 'complete' &&
    common &&
    exactKeys(value, [
      'version',
      'available',
      'status',
      'diagnosticSessionId',
      'stoppedAt',
      'stopReason',
      'observationCount',
      'aggregateCount',
      'dropped',
    ]) &&
    isIsoTime(value.stoppedAt) &&
    [
      'user-stop',
      'timeout',
      'backgrounded',
      'api-unavailable',
      'renderer-revoked',
    ].includes(String(value.stopReason))
  )
}

function isTiming(value: unknown): value is ResponsivenessTiming {
  return ['100-199ms', '200-499ms', '500ms-or-more'].includes(String(value))
}

function isClassification(value: unknown): value is ResponsivenessClassification {
  return value === 'input-paint-delay' || value === 'unattributed'
}

function isConfounder(value: unknown): value is ResponsivenessConfounder {
  return value === 'none' || value === 'runtime-or-environment'
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeCount(value) && value > 0
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
