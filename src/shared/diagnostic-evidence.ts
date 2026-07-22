export const DIAGNOSTIC_EVIDENCE_VERSION = 1

export interface DiagnosticEvidenceState {
  readonly version: typeof DIAGNOSTIC_EVIDENCE_VERSION
  readonly availability: 'durable' | 'memory-only' | 'unavailable'
  readonly recent: {
    readonly maxEvents: number
    readonly maxBytes: number
  }
  readonly journal?: {
    readonly location: string
    readonly maxSegments: number
    readonly maxSegmentBytes: number
    readonly retentionHours: number
  }
}

export type DiagnosticEvidenceDeleteResult =
  | {
      readonly ok: true
      readonly outcome: 'deleted'
      readonly state: DiagnosticEvidenceState
    }
  | {
      readonly ok: false
      readonly reason: 'storage-unavailable'
      readonly state: DiagnosticEvidenceState
    }

export function isDiagnosticEvidenceState(
  value: unknown,
): value is DiagnosticEvidenceState {
  if (!isRecord(value)) return false
  const journal = value['journal']
  const expected = ['version', 'availability', 'recent', ...(journal ? ['journal'] : [])]
  return (
    exactKeys(value, expected) &&
    value['version'] === DIAGNOSTIC_EVIDENCE_VERSION &&
    ['durable', 'memory-only', 'unavailable'].includes(String(value['availability'])) &&
    isRecentBound(value['recent']) &&
    (journal === undefined
      ? value['availability'] === 'memory-only'
      : value['availability'] !== 'memory-only' && isJournalBound(journal))
  )
}

export function isDiagnosticEvidenceDeleteResult(
  value: unknown,
): value is DiagnosticEvidenceDeleteResult {
  if (!isRecord(value) || !isDiagnosticEvidenceState(value['state'])) return false
  return value['ok'] === true
    ? exactKeys(value, ['ok', 'outcome', 'state']) && value['outcome'] === 'deleted'
    : value['ok'] === false &&
        exactKeys(value, ['ok', 'reason', 'state']) &&
        value['reason'] === 'storage-unavailable'
}

function isRecentBound(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ['maxEvents', 'maxBytes']) &&
    isPositiveSafeInteger(value['maxEvents']) &&
    isPositiveSafeInteger(value['maxBytes'])
  )
}

function isJournalBound(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ['location', 'maxSegments', 'maxSegmentBytes', 'retentionHours']) &&
    isBoundedLocation(value['location']) &&
    isPositiveSafeInteger(value['maxSegments']) &&
    isPositiveSafeInteger(value['maxSegmentBytes']) &&
    isPositiveSafeInteger(value['retentionHours'])
  )
}

function isBoundedLocation(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 4_096 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && codePoint !== 0x7f
    })
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
