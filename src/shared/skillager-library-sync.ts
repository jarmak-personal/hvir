import type { HostPath } from './host-path'
import type { SkillagerLibrary, SkillagerRequest, SkillagerTrust } from './skillager'

export const SKILLAGER_SYNC_OUTCOMES = [
  'created',
  'updated',
  'unchanged',
  'conflict',
  'skipped',
  'failed',
  'uncertain',
] as const
export type SkillagerSyncOutcome = (typeof SKILLAGER_SYNC_OUTCOMES)[number]

export interface SkillagerSyncCoverage {
  readonly discoveredOrigins: number
  readonly approvedOrigins: number
  readonly selectedSources: number
  readonly processedSources: number
  readonly complete: boolean
  readonly discoveryErrors: number
}

export interface SkillagerSyncItem {
  readonly sourceIdentity: string
  readonly originIds: readonly string[]
  readonly lineageId?: string
  readonly canonicalSkillId?: string
  readonly outcome: SkillagerSyncOutcome
  readonly phase:
    'not-started' | 'prepared' | 'published' | 'committed' | 'accepted' | 'unknown'
  readonly acceptedHash?: string
  readonly reason?: string
  readonly repair: 'none' | 'observe' | 'accept-pending' | 'resolve-conflict'
  /** Public recovery metadata, never a filesystem grant. */
  readonly recoveryPath?: HostPath
}

export interface SkillagerSyncOrigin {
  readonly id: string
  readonly skillId: string
  readonly sourceType: string
  readonly path: HostPath
  readonly entrypoint: HostPath
  readonly native?: {
    readonly agent: string
    readonly scope: 'project' | 'global'
    readonly projectRoot?: HostPath
  }
  readonly provenance: {
    readonly collection?: string
    readonly package?: string
    readonly version?: string
    readonly editable?: boolean
  }
  readonly observation: {
    readonly status:
      | 'current'
      | 'changed'
      | 'blocked'
      | 'unapproved'
      | 'missing'
      | 'unavailable'
      | 'not-observed'
    readonly contentHash?: string
    readonly trust?: SkillagerTrust
    readonly approvalEvidenceId?: string
  }
}

/** CLI-validated preservation is distinct from the canonical copy's own acceptance. */
export interface SkillagerLibraryLineage {
  readonly id: string
  readonly sourceIdentity: string
  readonly sourceApproval: {
    readonly evidenceId: string
    readonly decisionSkillId: string
    readonly scope: 'project' | 'global'
    readonly state: 'reviewed' | 'trusted' | 'pinned'
    readonly contentHash: string
    readonly lintOverride: boolean
    readonly riskOverride: boolean
  }
  readonly canonical: {
    readonly libraryId: string
    readonly skillId: string
    readonly path: HostPath
    readonly acceptedHash?: string
    readonly workingHash?: string
    readonly acceptance: 'accepted' | 'pending' | 'missing' | 'unavailable'
    readonly trust: SkillagerTrust
    readonly reuse: 'all-projects'
    readonly gitCommit?: string
  }
  readonly origins: readonly SkillagerSyncOrigin[]
  readonly preservation: 'verified' | 'pending' | 'conflict' | 'unavailable'
  readonly reason?: string
}

interface SkillagerSyncObservation {
  readonly library?: SkillagerLibrary
  readonly context?: HostPath
  readonly coverage: SkillagerSyncCoverage
  readonly reason?: string
}

export interface SkillagerSyncCompletion extends SkillagerSyncObservation {
  readonly status: 'completed' | 'partial' | 'refused' | 'uncertain'
  readonly counts: Readonly<Record<SkillagerSyncOutcome, number>>
  readonly items: readonly SkillagerSyncItem[]
}

export interface SkillagerSyncStatus extends SkillagerSyncObservation {
  readonly status: 'observed' | 'refused'
  readonly lineages: readonly SkillagerLibraryLineage[]
  readonly candidates: readonly {
    readonly sourceIdentity: string
    readonly canonicalSkillId?: string
    readonly state:
      | 'eligible-create'
      | 'eligible-update'
      | 'current'
      | 'conflict'
      | 'skipped'
      | 'pending'
      | 'unavailable'
      | 'failed'
    readonly reason?: string
  }[]
}

export interface SkillagerSyncPreparation {
  readonly report: SkillagerSyncStatus
  readonly observationId?: string
  /** A prior uncertain write requires another explicit Sync gesture after observation. */
  readonly requiresNewSync: boolean
}

export interface SkillagerSyncRequest extends SkillagerRequest {
  readonly observationId: string
}
