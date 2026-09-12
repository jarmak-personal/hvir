import type { HostPath } from './host-path'

export const SKILLAGER_AGENTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
] as const
export type SkillagerAgent = (typeof SKILLAGER_AGENTS)[number]['id']
export type SkillagerSearchScope = 'library' | 'workspace'
export type SkillagerTrust =
  | 'reviewed'
  | 'trusted'
  | 'pinned'
  | 'blocked'
  | 'discovered'
  | 'lint_blocked'
  | 'unknown'

export interface SkillagerMetadata {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly trust: SkillagerTrust
  readonly source: {
    readonly type: string
    readonly collection?: string
    readonly package?: string
    readonly ownership: 'library' | 'external' | 'unknown'
    readonly libraryId?: string
  }
  readonly contentHash?: string
  readonly tags: readonly string[]
  readonly matchReasons: readonly string[]
  readonly exposure: string
  readonly scanRisk?: string
  readonly lintStatus?: string
  readonly workspaceCheckedAt?: number
  readonly workspaceFreshness?: 'fresh' | 'checking' | 'unavailable' | 'stale'
  readonly workspace?: SkillagerWorkspaceExposure
}

export interface SkillagerWorkspaceExposure {
  readonly id: string
  readonly skillId?: string
  readonly target: HostPath
  readonly mode: string
  readonly status: string
  readonly expectedSourceHash?: string
  /** CLI projection fingerprint; Stub hashes are not canonical source versions. */
  readonly currentHash?: string
  readonly reconciliation?: 'pending' | 'cleanup-pending'
}

export interface SkillagerLibrary {
  readonly id: string
  readonly root: HostPath
  readonly skillsRoot: HostPath
}

export type SkillagerFailureReason =
  | 'disabled'
  | 'missing'
  | 'invalid-executable'
  | 'unsupported'
  | 'not-initialized'
  | 'disconnected'
  | 'library-changed'
  | 'invalid-request'
  | 'unavailable'
  | 'malformed-result'
  | 'output-limit'
  | 'timeout'
  | 'busy'
  | 'cancelled'
  | 'command-failed'
  | 'stale-review'
  | 'review-refused'
  | 'review-expired'
  | 'uncertain'

export type SkillagerResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly reason: SkillagerFailureReason
      readonly message: string
    }

export interface SkillagerProbe {
  readonly probeId: string
  readonly executable: HostPath
  readonly version: string
  readonly library?: SkillagerLibrary
}

export interface SkillagerConnection {
  readonly connectionId: string
  readonly executable: HostPath
  readonly version: string
  readonly library: SkillagerLibrary
}

export interface SkillagerRequest {
  readonly connectionId: string
  readonly requestId: number
  readonly workspaceRoot: HostPath
  readonly agent: SkillagerAgent
}

export interface SkillagerSearchRequest extends SkillagerRequest {
  readonly query: string
  readonly scope: SkillagerSearchScope
}

export interface SkillagerMetadataResult {
  readonly rows: readonly SkillagerMetadata[]
  readonly checkedAt: number
  readonly durationMs: number
  readonly exposures?: readonly SkillagerWorkspaceExposure[]
}

export const SKILLAGER_SEARCH_LIMIT = 50
export const SKILLAGER_QUERY_BYTES = 1_000
export const SKILLAGER_INVENTORY_LIMIT = 10_000
export const SKILLAGER_REFRESH_MS = 60_000
