import type { SkillagerSetup } from './skillager-setup'
import type { HostPath } from './host-path'

export const SKILLAGER_AGENTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
] as const
export type SkillagerAgent = (typeof SKILLAGER_AGENTS)[number]['id']
export type SkillagerBrowseAgent = SkillagerAgent | 'all'
export function skillagerAgentLabel(agent: SkillagerAgent | undefined): string {
  return SKILLAGER_AGENTS.find((item) => item.id === agent)?.label ?? 'Project skill'
}
export type SkillagerSearchScope = 'library' | 'workspace'
export const SKILLAGER_ACCEPTED_TRUST = ['reviewed', 'trusted', 'pinned'] as const
export type SkillagerTrust =
  | 'reviewed'
  | 'trusted'
  | 'pinned'
  | 'blocked'
  | 'discovered'
  | 'lint_blocked'
  | 'unknown'

export interface SkillagerMetadata {
  /** Public search observation, not a body read or mutation grant. */
  readonly search?: SkillagerSearchIdentity
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
  readonly workspaceCopies?: readonly SkillagerWorkspaceExposure[]
  /** Proven public router memberships in this observation; undefined means unavailable. */
  readonly workspaceRouterCount?: number
  readonly routerMembership?: SkillagerWorkspaceExposure
  /** CLI-observed project presence; this is not an exposure or library grant. */
  readonly projectSkill?: {
    readonly path: HostPath
    readonly agent?: SkillagerAgent
    readonly managed: boolean
  }
}

export interface SkillagerWorkspaceExposure {
  readonly id: string
  readonly agent: SkillagerAgent
  readonly skillId?: string
  /** Present only when public CLI metadata or a trusted deployment binds the source library. */
  readonly sourceLibraryId?: string
  readonly target: HostPath
  readonly mode: string
  readonly status: string
  readonly expectedSourceHash?: string
  /** CLI projection fingerprint; Stub hashes are not canonical source versions. */
  readonly currentHash?: string
  readonly reconciliation?: 'pending' | 'cleanup-pending'
  readonly router?: {
    readonly slug: string
    readonly kind: string
    readonly tag?: string
    readonly skillIds: readonly string[]
    readonly memberSources?: readonly {
      readonly skillId: string
      readonly sourceLibraryId?: string
    }[]
  }
}

export interface SkillagerLibrary {
  readonly id: string
  readonly root: HostPath
  readonly skillsRoot: HostPath
}

export type SkillagerFailureReason =
  | 'search-unsupported'
  | 'installed-unknown'
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
  readonly setup?: SkillagerSetup
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

export interface SkillagerSetupCompletion {
  readonly probe: SkillagerProbe
  readonly connection?: SkillagerConnection
}

export interface SkillagerRequest {
  readonly connectionId: string
  readonly requestId: number
  readonly workspaceRoot: HostPath
  readonly agent: SkillagerAgent
}

/** Browsing preference never supplies mutation or setup target authority. */
export interface SkillagerBrowseRequest extends SkillagerRequest {
  readonly browseAgent?: SkillagerBrowseAgent
}

export interface SkillagerSearchRequest extends SkillagerBrowseRequest {
  readonly query: string
  readonly scope: SkillagerSearchScope
  readonly view?: SkillagerSearchView
  readonly includeInstalled?: boolean
}

export type SkillagerSearchView = 'skills' | 'copies' | 'legacy'
export interface SkillagerSearchContext {
  readonly scope: SkillagerSearchScope
  readonly browseAgent: SkillagerBrowseAgent
  readonly view: SkillagerSearchView
  readonly includeInstalled: boolean
}
export interface SkillagerSearchOccurrence {
  readonly id: string
  readonly kind:
    'library' | 'source' | 'project-original' | 'full' | 'stub' | 'router-member'
  readonly path: HostPath
  readonly entrypoint: HostPath
  readonly agent?: SkillagerAgent
  readonly sourceIdentity?: string
  /** Exact target selector only; top-level source hashes never describe these bytes. */
  readonly exposure?: Pick<
    SkillagerWorkspaceExposure,
    'id' | 'agent' | 'target' | 'mode'
  > & {
    readonly router?: {
      readonly slug: string
      readonly kind: string
      readonly tag?: string
    }
  }
}
export interface SkillagerSearchIdentity {
  readonly groupId: string
  readonly canonical?: { readonly libraryId: string; readonly skillId: string }
  readonly occurrence: SkillagerSearchOccurrence
  readonly groupOccurrences: number
  readonly installed: boolean | null
  readonly match: {
    readonly occurrence: SkillagerSearchOccurrence
    readonly skillId: string
    readonly contentHash: string
    readonly score: number
    readonly reasons: readonly string[]
  }
}
export interface SkillagerSearchObservation extends SkillagerSearchContext {
  readonly installedObservation: 'observed' | 'provided' | 'unknown' | 'legacy'
  readonly coverage: 'local-project' | 'hvir-deliveries' | 'none'
}
export interface SkillagerSearchRows {
  readonly rows: readonly SkillagerMetadata[]
  readonly search: SkillagerSearchObservation
}

export interface SkillagerMetadataResult {
  readonly search?: SkillagerSearchObservation
  readonly rows: readonly SkillagerMetadata[]
  readonly checkedAt: number
  readonly durationMs: number
  readonly exposures?: readonly SkillagerWorkspaceExposure[]
}

export const SKILLAGER_SEARCH_LIMIT = 50
export const SKILLAGER_QUERY_BYTES = 1_000
export const SKILLAGER_INVENTORY_LIMIT = 10_000
export const SKILLAGER_REFRESH_MS = 60_000
