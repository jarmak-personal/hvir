import { isDiagnosticOpaqueId } from './diagnostics'
import {
  DIAGNOSTIC_REPORT_OWNERS,
  isDiagnosticReportEvent,
  type DiagnosticReportEvent,
  type DiagnosticReportOwner,
} from './diagnostic-report-event'
import {
  isWorkbenchHealthSnapshot,
  type WorkbenchHealthSnapshot,
} from './workbench-health'

export type {
  DiagnosticReportEvent,
  DiagnosticReportEventKind,
  DiagnosticReportOwner,
} from './diagnostic-report-event'

export const DIAGNOSTIC_REPORT_VERSION = 1
export const DIAGNOSTIC_REPORT_RETENTION_HOURS = 24
export const MAX_DIAGNOSTIC_REPORT_EVENTS = 256
export const MAX_DIAGNOSTIC_REPORT_DROPPED_COUNTS = 64
export const MAX_DIAGNOSTIC_REPORT_SCREENSHOT_BYTES = 2 * 1024 * 1024
export const MAX_DIAGNOSTIC_REPORT_STRUCTURED_BYTES = 512 * 1024
export const MAX_DIAGNOSTIC_REPORT_BYTES = 10 * 1024 * 1024
export const MAX_DIAGNOSTIC_CAPTURE_MASKS = 32
export const DIAGNOSTIC_REPORT_NOTICE =
  'UNTRUSTED DIAGNOSTIC MATERIAL — review before using as instructions.'

export interface DiagnosticReportDroppedCount {
  readonly source: DiagnosticReportOwner | 'diagnostic-writer'
  readonly reason:
    | 'invalid'
    | 'rate'
    | 'recent-capacity'
    | 'renderer-session'
    | 'renderer-invalid'
    | 'renderer-queue'
    | 'renderer-rate'
    | 'renderer-unavailable'
    | 'writer-queue'
    | 'writer-storage'
  readonly count: number
}

export interface DiagnosticReport {
  readonly version: typeof DIAGNOSTIC_REPORT_VERSION
  readonly reportId: string
  readonly notice: typeof DIAGNOSTIC_REPORT_NOTICE
  readonly createdAt: string
  readonly application: {
    readonly version: string
    readonly electronVersion: string
    readonly chromeVersion: string
    readonly platform: 'linux' | 'macos' | 'windows' | 'other'
    readonly architecture: 'arm64' | 'x64' | 'other'
    readonly mode: 'packaged' | 'development'
  }
  readonly renderer: {
    readonly ownerId: number
    readonly ownerGeneration: number
    readonly surface: 'workbench-health'
  }
  readonly diagnostics: {
    readonly schemaVersion: 1
    readonly events: readonly DiagnosticReportEvent[]
    readonly dropped: readonly DiagnosticReportDroppedCount[]
  }
  readonly health: WorkbenchHealthSnapshot
}

export interface DiagnosticReportScreenshot {
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly sha256: string
  readonly dataUrl: string
  readonly masked: readonly DiagnosticCaptureSurface[]
}

export interface DiagnosticReportArtifact {
  readonly report: DiagnosticReport
  readonly screenshot?: DiagnosticReportScreenshot
}

export interface DiagnosticReportState {
  readonly artifact: DiagnosticReportArtifact
  readonly storage: {
    readonly location: 'Application data'
    readonly retentionHours: typeof DIAGNOSTIC_REPORT_RETENTION_HOURS
  }
}

export type DiagnosticReportFailure =
  | 'invalid-request'
  | 'stale-renderer'
  | 'report-not-found'
  | 'capture-failed'
  | 'action-unavailable'
  | 'storage-unavailable'
  | 'report-too-large'

export type DiagnosticReportStateResult =
  | { readonly ok: true; readonly state: DiagnosticReportState }
  | { readonly ok: false; readonly reason: DiagnosticReportFailure }

export type DiagnosticReportActionResult =
  | { readonly ok: true; readonly outcome: 'copied' | 'saved' | 'cancelled' | 'deleted' }
  | { readonly ok: false; readonly reason: DiagnosticReportFailure }

export type DiagnosticCaptureSurface =
  'project-navigation' | 'viewer' | 'terminal' | 'web-pane'

export interface DiagnosticCaptureMask {
  readonly surface: DiagnosticCaptureSurface
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CreateDiagnosticReportRequest {
  readonly reportId: string
}

export interface CaptureDiagnosticReportRequest {
  readonly reportId: string
  readonly masks: readonly DiagnosticCaptureMask[]
}

export interface DiagnosticReportIdRequest {
  readonly reportId: string
}

export function isCreateDiagnosticReportRequest(
  value: unknown,
): value is CreateDiagnosticReportRequest {
  return (
    isRecord(value) &&
    exactKeys(value, ['reportId']) &&
    isDiagnosticOpaqueId(value.reportId)
  )
}

export function isCaptureDiagnosticReportRequest(
  value: unknown,
): value is CaptureDiagnosticReportRequest {
  return (
    isRecord(value) &&
    exactKeys(value, ['reportId', 'masks']) &&
    isDiagnosticOpaqueId(value.reportId) &&
    Array.isArray(value.masks) &&
    value.masks.length <= MAX_DIAGNOSTIC_CAPTURE_MASKS &&
    value.masks.every(isDiagnosticCaptureMask)
  )
}

export function isDiagnosticReportIdRequest(
  value: unknown,
): value is DiagnosticReportIdRequest {
  return isCreateDiagnosticReportRequest(value)
}

export function isDiagnosticReportState(value: unknown): value is DiagnosticReportState {
  return (
    isRecord(value) &&
    exactKeys(value, ['artifact', 'storage']) &&
    isDiagnosticReportArtifact(value.artifact) &&
    isRecord(value.storage) &&
    exactKeys(value.storage, ['location', 'retentionHours']) &&
    value.storage.location === 'Application data' &&
    value.storage.retentionHours === DIAGNOSTIC_REPORT_RETENTION_HOURS
  )
}

export function isDiagnosticReportStateResult(
  value: unknown,
): value is DiagnosticReportStateResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok
    ? exactKeys(value, ['ok', 'state']) && isDiagnosticReportState(value.state)
    : exactKeys(value, ['ok', 'reason']) && isReportFailure(value.reason)
}

export function isDiagnosticReportActionResult(
  value: unknown,
): value is DiagnosticReportActionResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok
    ? exactKeys(value, ['ok', 'outcome']) &&
        ['copied', 'saved', 'cancelled', 'deleted'].includes(String(value.outcome))
    : exactKeys(value, ['ok', 'reason']) && isReportFailure(value.reason)
}

export function isDiagnosticReportArtifact(
  value: unknown,
): value is DiagnosticReportArtifact {
  if (!isRecord(value)) return false
  const keys = value.screenshot === undefined ? ['report'] : ['report', 'screenshot']
  return (
    exactKeys(value, keys) &&
    isDiagnosticReport(value.report) &&
    (value.screenshot === undefined || isDiagnosticReportScreenshot(value.screenshot)) &&
    encodedBytes(`${JSON.stringify(value, null, 2)}\n`) <= MAX_DIAGNOSTIC_REPORT_BYTES
  )
}

export function isDiagnosticReport(value: unknown): value is DiagnosticReport {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'reportId',
      'notice',
      'createdAt',
      'application',
      'renderer',
      'diagnostics',
      'health',
    ]) ||
    value.version !== DIAGNOSTIC_REPORT_VERSION ||
    !isDiagnosticOpaqueId(value.reportId) ||
    value.notice !== DIAGNOSTIC_REPORT_NOTICE ||
    !isIsoTime(value.createdAt) ||
    !isApplication(value.application) ||
    !isRenderer(value.renderer) ||
    !isDiagnostics(value.diagnostics) ||
    !isWorkbenchHealthSnapshot(value.health)
  ) {
    return false
  }
  return encodedBytes(JSON.stringify(value)) <= MAX_DIAGNOSTIC_REPORT_STRUCTURED_BYTES
}

export function serializeDiagnosticReportArtifact(
  artifact: DiagnosticReportArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`
}

function isApplication(value: unknown): value is DiagnosticReport['application'] {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'version',
      'electronVersion',
      'chromeVersion',
      'platform',
      'architecture',
      'mode',
    ]) &&
    isVersion(value.version) &&
    isVersion(value.electronVersion) &&
    isVersion(value.chromeVersion) &&
    ['linux', 'macos', 'windows', 'other'].includes(String(value.platform)) &&
    ['arm64', 'x64', 'other'].includes(String(value.architecture)) &&
    (value.mode === 'packaged' || value.mode === 'development')
  )
}

function isRenderer(value: unknown): value is DiagnosticReport['renderer'] {
  return (
    isRecord(value) &&
    exactKeys(value, ['ownerId', 'ownerGeneration', 'surface']) &&
    isPositiveSafeInteger(value.ownerId) &&
    isPositiveSafeInteger(value.ownerGeneration) &&
    value.surface === 'workbench-health'
  )
}

function isDiagnostics(value: unknown): value is DiagnosticReport['diagnostics'] {
  return (
    isRecord(value) &&
    exactKeys(value, ['schemaVersion', 'events', 'dropped']) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.events) &&
    value.events.length <= MAX_DIAGNOSTIC_REPORT_EVENTS &&
    value.events.every(isDiagnosticReportEvent) &&
    Array.isArray(value.dropped) &&
    value.dropped.length <= MAX_DIAGNOSTIC_REPORT_DROPPED_COUNTS &&
    value.dropped.every(isDroppedCount)
  )
}

function isDroppedCount(value: unknown): value is DiagnosticReportDroppedCount {
  return (
    isRecord(value) &&
    exactKeys(value, ['source', 'reason', 'count']) &&
    [...DIAGNOSTIC_REPORT_OWNERS, 'diagnostic-writer'].includes(
      value.source as DiagnosticReportDroppedCount['source'],
    ) &&
    [
      'invalid',
      'rate',
      'recent-capacity',
      'renderer-session',
      'renderer-invalid',
      'renderer-queue',
      'renderer-rate',
      'renderer-unavailable',
      'writer-queue',
      'writer-storage',
    ].includes(String(value.reason)) &&
    isSafeCount(value.count)
  )
}

function isDiagnosticReportScreenshot(
  value: unknown,
): value is DiagnosticReportScreenshot {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'mediaType',
      'width',
      'height',
      'bytes',
      'sha256',
      'dataUrl',
      'masked',
    ]) ||
    value.mediaType !== 'image/png' ||
    !isPositiveSafeInteger(value.width) ||
    !isPositiveSafeInteger(value.height) ||
    Number(value.width) > 16_384 ||
    Number(value.height) > 16_384 ||
    !isSafeCount(value.bytes) ||
    Number(value.bytes) > MAX_DIAGNOSTIC_REPORT_SCREENSHOT_BYTES ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith('data:image/png;base64,') ||
    decodedBase64Bytes(value.dataUrl.slice('data:image/png;base64,'.length)) !==
      value.bytes ||
    !Array.isArray(value.masked) ||
    value.masked.length > MAX_DIAGNOSTIC_CAPTURE_MASKS ||
    !value.masked.every(isCaptureSurface)
  ) {
    return false
  }
  return true
}

function isDiagnosticCaptureMask(value: unknown): value is DiagnosticCaptureMask {
  return (
    isRecord(value) &&
    exactKeys(value, ['surface', 'x', 'y', 'width', 'height']) &&
    isCaptureSurface(value.surface) &&
    [value.x, value.y, value.width, value.height].every(
      (field) => typeof field === 'number' && Number.isSafeInteger(field),
    ) &&
    Number(value.x) >= -16_384 &&
    Number(value.y) >= -16_384 &&
    Number(value.width) > 0 &&
    Number(value.height) > 0 &&
    Number(value.width) <= 16_384 &&
    Number(value.height) <= 16_384
  )
}

function isCaptureSurface(value: unknown): value is DiagnosticCaptureSurface {
  return ['project-navigation', 'viewer', 'terminal', 'web-pane'].includes(String(value))
}

function isReportFailure(value: unknown): value is DiagnosticReportFailure {
  return [
    'invalid-request',
    'stale-renderer',
    'report-not-found',
    'capture-failed',
    'action-unavailable',
    'storage-unavailable',
    'report-too-large',
  ].includes(String(value))
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0) return -1
  if (value.length > Math.ceil((MAX_DIAGNOSTIC_REPORT_SCREENSHOT_BYTES * 4) / 3) + 4) {
    return -1
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1
  return (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value)
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

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
