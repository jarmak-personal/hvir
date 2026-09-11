import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
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
  | { readonly type: 'observe'; readonly result: SkillagerMetadataResult }
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
    case 'observe': {
      const rows = new Map(
        skillagerWorkspaceMetadata(action.result).map((row) => [row.id, row]),
      )
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          const metadata = rows.get(tab.metadata.id)
          if (metadata) return { ...tab, metadata }
          if (tab.metadata.source.ownership !== 'library') return tab
          return {
            ...tab,
            metadata: {
              ...tab.metadata,
              trust: 'unknown',
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
    exposure: data.exposures ? (exposures.get(row.id)?.mode ?? 'hidden') : row.exposure,
  }))
}
