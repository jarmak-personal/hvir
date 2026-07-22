import type { WorkbenchHealthRecoveryOutcome } from '../../shared'

export type WindowHealthDiagnostic =
  | {
      readonly kind: 'main-document-load-failed'
      readonly ownerId: number
      readonly ownerGeneration: number
      readonly occurrenceId: string
      readonly failure: 'not-found' | 'connection' | 'certificate' | 'other'
      readonly impact: 'degraded' | 'critical'
    }
  | {
      readonly kind: 'renderer-process-exited'
      readonly ownerId: number
      readonly ownerGeneration: number
      readonly occurrenceId: string
      readonly reason: 'crashed' | 'killed' | 'oom' | 'integrity' | 'launch' | 'other'
    }
  | {
      readonly kind: 'renderer-unresponsive'
      readonly ownerId: number
      readonly ownerGeneration: number
      readonly occurrenceId: string
    }
  | {
      readonly kind: 'workbench-health-recovered'
      readonly ownerId: number
      readonly ownerGeneration: number
      readonly occurrenceId: string
      readonly outcome: WorkbenchHealthRecoveryOutcome
    }
