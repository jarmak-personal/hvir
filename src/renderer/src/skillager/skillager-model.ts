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
      const id = skillagerMetadataKey(action.metadata)
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
        [
          ...skillagerWorkspaceMetadata(action.result),
          ...skillagerProjectRows(action.result),
        ].map((row) => [skillagerMetadataKey(row), row]),
      )
      const canonical = new Map(
        action.result.rows
          .filter((row) => row.source.ownership === 'library')
          .map((row) => [JSON.stringify([row.source.libraryId, row.id]), row]),
      )
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          if (tab.metadata.routerMembership) {
            const router = rows.get(
              skillagerMetadataKey({
                ...tab.metadata,
                workspace: tab.metadata.routerMembership,
                routerMembership: undefined,
              }),
            )?.workspace
            return router?.router?.skillIds.includes(tab.metadata.id)
              ? {
                  ...tab,
                  metadata: {
                    ...skillagerRouterMember(router, tab.metadata.id, canonical),
                    workspaceFreshness: 'fresh',
                    workspaceCheckedAt: action.result.checkedAt,
                  },
                }
              : {
                  ...tab,
                  metadata: {
                    ...tab.metadata,
                    trust: 'unknown',
                    contentHash: undefined,
                    workspaceFreshness: 'unavailable',
                    description:
                      'This router membership is no longer reported by Skillager.',
                  },
                }
          }
          const metadata = rows.get(tab.id)
          if (metadata) return { ...tab, metadata }
          if (action.type === 'observe-project')
            return tab.metadata.projectSkill || tab.metadata.workspace
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
  const exposures = new Map<string, SkillagerWorkspaceExposure[]>()
  for (const copy of data.exposures ?? []) {
    if (!copy.skillId || !copy.sourceLibraryId || copy.router) continue
    const identity = JSON.stringify([copy.sourceLibraryId, copy.skillId])
    const copies = exposures.get(identity) ?? []
    copies.push(copy)
    exposures.set(identity, copies)
  }
  return data.rows.map((row) => ({
    ...row,
    workspace: undefined,
    workspaceCopies: exposures.get(JSON.stringify([row.source.libraryId, row.id])) ?? [],
    workspaceCheckedAt: data.checkedAt,
    workspaceFreshness: data.exposures ? 'fresh' : 'unavailable',
    exposure: data.exposures
      ? exposures.has(JSON.stringify([row.source.libraryId, row.id])) ||
        Boolean(row.workspaceRouterCount)
        ? 'project'
        : 'hidden'
      : row.exposure,
  }))
}

/** Stable source and occurrence identities do not depend on filter, label or array order. */
export function skillagerMetadataKey(row: SkillagerMetadata): string {
  if (row.routerMembership)
    return `skillager:member:${JSON.stringify([
      row.routerMembership.target.hostId,
      row.routerMembership.target.path,
      row.routerMembership.agent,
      row.routerMembership.id,
      row.id,
    ])}`
  if (row.workspace)
    return `skillager:copy:${JSON.stringify([
      row.workspace.target.hostId,
      row.workspace.target.path,
      row.workspace.agent,
      row.workspace.id,
    ])}`
  if (row.projectSkill)
    return `skillager:origin:${JSON.stringify([
      row.projectSkill.path.hostId,
      row.projectSkill.path.path,
      row.projectSkill.agent,
      row.id,
    ])}`
  return `skillager:source:${JSON.stringify([
    row.source.libraryId ?? row.source.collection ?? row.source.type,
    row.id,
  ])}`
}

export function skillagerRouterMember(
  router: SkillagerWorkspaceExposure,
  id: string,
  canonical: ReadonlyMap<string, SkillagerMetadata>,
): SkillagerMetadata {
  const libraryId = router.router?.memberSources?.find(
    (member) => member.skillId === id,
  )?.sourceLibraryId
  return {
    ...((libraryId ? canonical.get(JSON.stringify([libraryId, id])) : undefined) ?? {
      id,
      name: id,
      description: 'Member source metadata is unavailable.',
      trust: 'unknown',
      source: { type: 'router-member', ownership: 'unknown' },
      tags: [],
      matchReasons: [],
      exposure: 'router',
    }),
    workspace: undefined,
    workspaceCopies: undefined,
    routerMembership: router,
  }
}

export function isNativeProjectSkill(row: SkillagerMetadata): row is SkillagerMetadata & {
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
      .map((row) => [JSON.stringify([row.source.libraryId, row.id]), row]),
  )
  return [
    ...metadata.filter(isNativeProjectSkill),
    ...(data.exposures ?? []).map((exposure) => ({
      ...((exposure.sourceLibraryId
        ? owned.get(JSON.stringify([exposure.sourceLibraryId, exposure.skillId]))
        : undefined) ?? unavailableSource(exposure)),
      workspace: exposure,
      workspaceCopies: undefined,
      exposure: exposure.mode,
      workspaceFreshness: 'fresh' as const,
      workspaceCheckedAt: data.checkedAt,
    })),
  ]
}
function unavailableSource(exposure: SkillagerWorkspaceExposure): SkillagerMetadata {
  return {
    id: exposure.skillId ?? exposure.id,
    name:
      exposure.router?.tag ?? exposure.router?.slug ?? exposure.skillId ?? exposure.id,
    description: 'Source metadata is unavailable.',
    trust: 'unknown',
    source: { type: 'workspace', ownership: 'unknown' },
    tags: [],
    matchReasons: [],
    exposure: exposure.mode,
    workspace: exposure,
  }
}
