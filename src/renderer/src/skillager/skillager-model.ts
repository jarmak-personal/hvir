import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerWorkspaceExposure,
} from '../../../shared/skillager'

export interface SkillagerDetailTab {
  readonly id: string
  readonly metadata: SkillagerMetadata
}
export interface SkillagerTabs {
  readonly tabs: readonly SkillagerDetailTab[]
  readonly activeId?: string
}
export type SkillagerTabAction =
  | { readonly type: 'select'; readonly metadata: SkillagerMetadata }
  | {
      readonly type: 'observe' | 'observe-project'
      readonly result: SkillagerMetadataResult
    }
  | {
      readonly type: 'invalidate'
      readonly freshness: 'checking' | 'stale' | 'unavailable'
    }
  | { readonly type: 'activate'; readonly id: string }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'deactivate' | 'clear' }

export function skillagerTabs(
  state: SkillagerTabs,
  action: SkillagerTabAction,
): SkillagerTabs {
  switch (action.type) {
    case 'select': {
      const id = `skillager:${action.metadata.source.libraryId ?? action.metadata.source.collection ?? action.metadata.source.type}:${action.metadata.id}`
      const previous = state.tabs.find((tab) => tab.id === id)
      return {
        tabs: previous
          ? state.tabs.map((tab) =>
              tab.id === id ? { id, metadata: action.metadata } : tab,
            )
          : [...state.tabs.slice(-19), { id, metadata: action.metadata }],
        activeId: id,
      }
    }
    case 'invalidate':
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          metadata: { ...tab.metadata, workspaceFreshness: action.freshness },
        })),
      }
    case 'observe-project':
    case 'observe': {
      const rows = new Map(
        (action.type === 'observe-project'
          ? skillagerProjectRows(action.result)
          : skillagerWorkspaceMetadata(action.result)
        ).map((row) => [row.id, row]),
      )
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          const metadata = rows.get(tab.metadata.id)
          if (metadata) return { ...tab, metadata }
          if (action.type === 'observe-project')
            return tab.metadata.projectSkill
              ? {
                  ...tab,
                  metadata: {
                    ...tab.metadata,
                    workspaceFreshness: 'unavailable',
                    description: 'Skillager no longer reports this project skill.',
                  },
                }
              : tab
          if (tab.metadata.source.ownership !== 'library') return tab
          return {
            ...tab,
            metadata: {
              ...tab.metadata,
              trust: 'unknown',
              workspaceFreshness: 'unavailable',
              contentHash: undefined,
              description: 'This skill is no longer in the personal library.',
            },
          }
        }),
      }
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id }
        : state
    case 'close':
      return {
        tabs: state.tabs.filter((tab) => tab.id !== action.id),
        activeId: state.activeId === action.id ? undefined : state.activeId,
      }
    case 'deactivate':
      return { ...state, activeId: undefined }
    case 'clear':
      return { tabs: [] }
  }
}

export function pendingSkillagerReview(row: SkillagerMetadata): boolean {
  return row.trust === 'discovered' || row.trust === 'lint_blocked'
}

export function skillagerObservationDemand(
  enabled: boolean,
  connected: boolean,
  foreground: boolean,
  sidebar: boolean,
  detail: boolean,
): boolean {
  return enabled && connected && foreground && (sidebar || detail)
}

export function trustLabel(row: SkillagerMetadata): string {
  return pendingSkillagerReview(row)
    ? 'Pending review'
    : row.trust === 'blocked'
      ? 'Blocked'
      : row.trust === 'pinned'
        ? 'Pinned'
        : row.trust === 'unknown'
          ? 'Review state unknown'
          : 'Accepted'
}

export function skillagerWorkspaceMetadata(
  data: SkillagerMetadataResult,
): readonly SkillagerMetadata[] {
  const exposures = new Map(data.exposures?.map((row) => [row.skillId, row]))
  return data.rows.map((row) => ({
    ...row,
    workspace: exposures.get(row.id),
    workspaceCheckedAt: data.checkedAt,
    workspaceFreshness: data.exposures ? 'fresh' : 'unavailable',
    exposure: data.exposures ? (exposures.get(row.id)?.mode ?? 'hidden') : row.exposure,
  }))
}

export function isNativeProjectSkill(
  row: SkillagerMetadata,
): row is SkillagerMetadata & {
  readonly projectSkill: NonNullable<SkillagerMetadata['projectSkill']>
} {
  return Boolean(row.projectSkill) && row.source.ownership !== 'library'
}

/** Native discovery excludes managed targets; copies retain only actual owned source metadata. */
export function skillagerProjectRows(
  data: SkillagerMetadataResult,
): readonly SkillagerMetadata[] {
  const metadata = skillagerWorkspaceMetadata(data)
  const owned = new Map(
    metadata
      .filter((row) => row.source.ownership === 'library')
      .map((row) => [row.id, row]),
  )
  return [
    ...metadata.filter(isNativeProjectSkill),
    ...(data.exposures ?? []).map((exposure) => ({
      ...(owned.get(exposure.skillId ?? '') ?? unavailableSource(exposure)),
      workspace: exposure,
      workspaceFreshness: 'fresh' as const,
      workspaceCheckedAt: data.checkedAt,
    })),
  ]
}
function unavailableSource(exposure: SkillagerWorkspaceExposure): SkillagerMetadata {
  return {
    id: exposure.skillId ?? exposure.id,
    name: exposure.skillId ?? exposure.id,
    description: 'Source metadata is unavailable.',
    trust: 'unknown',
    source: { type: 'workspace', ownership: 'unknown' },
    tags: [],
    matchReasons: [],
    exposure: exposure.mode,
    workspace: exposure,
  }
}
