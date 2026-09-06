import type {
  DiagnosticSource,
  SerializedDiagnosticEvent,
  StoredDiagnosticEvent,
} from './diagnostic-event'

/** Closed evidence shared by admission, storage, and report preparation. */
export const DIAGNOSTIC_EVENT_BYTES = 1024

export type DiagnosticDropReason =
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

export interface DiagnosticDroppedCount {
  readonly source: DiagnosticSource | 'diagnostic-writer'
  readonly reason: DiagnosticDropReason
  readonly count: number
}

export interface DiagnosticRecentSnapshot {
  readonly version: 1
  readonly events: readonly StoredDiagnosticEvent[]
  readonly dropped: readonly DiagnosticDroppedCount[]
}

export interface DurableDiagnosticEvidence {
  readonly availability: 'available' | 'partial' | 'unavailable'
  readonly events: readonly StoredDiagnosticEvent[]
}

export interface DiagnosticJournalStatus {
  readonly location: string
  readonly sink: 'available' | 'failed'
  readonly dropped: Readonly<{
    queue: number
    storage: number
  }>
}

/** Admission can offer a closed serialized event without owning journal storage. */
export interface DiagnosticEvidenceWriter {
  record(line: SerializedDiagnosticEvent): boolean
  status(): DiagnosticJournalStatus
}
