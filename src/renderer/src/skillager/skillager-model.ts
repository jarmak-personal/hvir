import { skillagerSourceKey } from '../../../shared/skillager-source-identity'
import { hostPathEquals } from '../../../shared/host-path'
import {
  skillagerAgentLabel,
  type SkillagerSearchOccurrence,
} from '../../../shared/skillager'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerWorkspaceExposure,
} from '../../../shared/skillager'

export interface SkillagerCanonicalObservation {
  readonly rows: ReadonlyMap<string, SkillagerMetadata>
  readonly checkedAt?: number
  readonly freshness: NonNullable<SkillagerMetadata['workspaceFreshness']>
}

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
      readonly canonical?: SkillagerCanonicalObservation
    }
  | {
      readonly type: 'invalidate'
      readonly freshness: 'checking' | 'stale' | 'unavailable'
      readonly scope?: 'library' | 'project'
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
        tabs: state.tabs.map((tab) => {
          const native = Boolean(tab.metadata.projectSkill)
          if (action.scope === 'library' && native) return tab
          if (
            action.scope === 'project' &&
            !native &&
            !tab.metadata.workspace &&
            !tab.metadata.routerMembership
          )
            return tab
          return {
            ...tab,
            metadata: { ...tab.metadata, workspaceFreshness: action.freshness },
          }
        }),
      }
    case 'observe-project':
    case 'observe': {
      const canonical = action.canonical ?? {
        rows: canonicalSkillagerMetadata(action.result.rows),
        checkedAt: action.result.checkedAt,
        freshness: 'fresh' as const,
      }
      const rows = new Map(
        [
          ...skillagerWorkspaceMetadata(action.result),
          ...skillagerProjectRows(action.result, canonical),
        ].map((row) => [skillagerMetadataKey(row), row]),
      )
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          // Inventory refresh never substitutes new bytes/identity for a selected search observation.
          if (tab.metadata.search)
            return tab.metadata.search.occurrence.exposure
              ? {
                  ...tab,
                  metadata: searchOccurrenceMetadata(tab.metadata, action.result),
                }
              : tab
          if (
            (tab.metadata.workspace || tab.metadata.routerMembership) &&
            !action.result.exposures
          )
            return {
              ...tab,
              metadata: unavailableOccurrence(
                tab.metadata,
                canonical.rows,
                action.result.checkedAt,
              ),
            }
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
                  metadata: skillagerRouterMember(router, tab.metadata.id, canonical, {
                    workspaceFreshness: 'fresh',
                    workspaceCheckedAt: action.result.checkedAt,
                  }),
                }
              : {
                  ...tab,
                  metadata: unavailableOccurrence(
                    tab.metadata,
                    canonical.rows,
                    action.result.checkedAt,
                    'This router membership is no longer reported by Skillager.',
                  ),
                }
          }
          const metadata = rows.get(tab.id)
          if (metadata) return { ...tab, metadata }
          if (tab.metadata.workspace)
            return {
              ...tab,
              metadata: unavailableOccurrence(
                tab.metadata,
                canonical.rows,
                action.result.checkedAt,
                'This project copy is no longer reported by Skillager.',
              ),
            }
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
  const exposures = new Map<string, SkillagerWorkspaceExposure[]>()
  for (const copy of data.exposures ?? []) {
    const identity = skillagerSourceKey(copy.sourceLibraryId, copy.skillId)
    if (!identity || copy.router) continue
    const copies = exposures.get(identity) ?? []
    copies.push(copy)
    exposures.set(identity, copies)
  }
  return data.rows.map((row) => {
    if (row.search) return searchOccurrenceMetadata(row, data)
    const key = skillagerSourceKey(row.source.libraryId, row.id)
    const copies = key ? (exposures.get(key) ?? []) : []
    return {
      ...row,
      workspace: undefined,
      workspaceCopies: copies,
      workspaceCheckedAt: data.checkedAt,
      workspaceFreshness: data.exposures ? 'fresh' : 'unavailable',
      exposure: data.exposures
        ? copies.length || row.workspaceRouterCount
          ? 'project'
          : 'hidden'
        : row.exposure,
    }
  })
}

/** Stable source and occurrence identities do not depend on filter, label or array order. */
export function skillagerMetadataKey(row: SkillagerMetadata): string {
  if (row.routerMembership)
    return `skillager:member:${JSON.stringify([
      row.routerMembership.target.hostId,
      row.routerMembership.target.path,
      row.routerMembership.agent,
      row.routerMembership.id,
      skillagerRouterMemberId(row),
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
  if (row.search && row.source.ownership !== 'library')
    return `skillager:search-occurrence:${row.search.occurrence.id}`
  return `skillager:source:${skillagerSourceKey(row.source.libraryId, row.id) ?? JSON.stringify([row.source.collection ?? row.source.type, row.id])}`
}

/** A member's canonical identity and the accepted source supplying metadata may differ. */
export function skillagerRouterMemberId(row: SkillagerMetadata): string {
  return row.search?.canonical?.skillId ?? row.id
}

export function skillagerOccurrenceLabel(occurrence: SkillagerSearchOccurrence): string {
  const label = {
    library: 'Your library',
    source: 'External source',
    'project-original': 'Project original',
    full: 'Installed Full',
    stub: 'Installed Stub',
    'router-member': 'Installed Router',
  }[occurrence.kind]
  return occurrence.agent ? `${label} · ${skillagerAgentLabel(occurrence.agent)}` : label
}

function searchOccurrenceMetadata(
  row: SkillagerMetadata,
  data: SkillagerMetadataResult,
): SkillagerMetadata {
  const selected = row.search!.occurrence.exposure
  if (!selected)
    return {
      ...row,
      workspaceCopies: undefined,
      workspaceCheckedAt: data.checkedAt,
      workspaceFreshness: 'fresh',
    }
  const canonical = row.search!.canonical!
  const observed = data.exposures?.find(
    (copy) =>
      copy.id === selected.id &&
      copy.agent === selected.agent &&
      copy.mode === selected.mode &&
      hostPathEquals(copy.target, selected.target) &&
      (selected.router
        ? copy.router?.memberSources?.some(
            (member) =>
              member.skillId === canonical.skillId &&
              member.sourceLibraryId === canonical.libraryId,
          )
        : copy.skillId === canonical.skillId &&
          copy.sourceLibraryId === canonical.libraryId),
  )
  const copy: SkillagerWorkspaceExposure = observed ?? {
    ...selected,
    skillId: selected.router ? undefined : canonical.skillId,
    sourceLibraryId: selected.router ? undefined : canonical.libraryId,
    status: 'unverified',
    router: selected.router ? { ...selected.router, skillIds: [] } : undefined,
  }
  return {
    ...row,
    workspaceCopies: undefined,
    workspace: selected.router ? undefined : copy,
    routerMembership: selected.router ? copy : undefined,
    workspaceCheckedAt: data.checkedAt,
    workspaceFreshness: observed ? 'fresh' : 'unavailable',
  }
}

export function skillagerRouterMember(
  router: SkillagerWorkspaceExposure,
  id: string,
  canonical: SkillagerCanonicalObservation,
  observation?: Pick<SkillagerMetadata, 'workspaceFreshness' | 'workspaceCheckedAt'>,
): SkillagerMetadata {
  const libraryId = router.router?.memberSources?.find(
    (member) => member.skillId === id,
  )?.sourceLibraryId
  const key = skillagerSourceKey(libraryId, id)
  const source = key ? canonical.rows.get(key) : undefined
  return {
    ...(source ?? {
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
    workspaceFreshness:
      observation?.workspaceFreshness && observation.workspaceFreshness !== 'fresh'
        ? observation.workspaceFreshness
        : source
          ? canonical.freshness
          : (observation?.workspaceFreshness ?? 'fresh'),
    workspaceCheckedAt:
      source && canonical.checkedAt !== undefined
        ? Math.min(
            observation?.workspaceCheckedAt ?? canonical.checkedAt,
            canonical.checkedAt,
          )
        : observation?.workspaceCheckedAt,
  }
}

export function isNativeProjectSkill(row: SkillagerMetadata): row is SkillagerMetadata & {
  readonly projectSkill: NonNullable<SkillagerMetadata['projectSkill']>
} {
  return (
    Boolean(row.projectSkill) &&
    !row.projectSkill?.managed &&
    row.source.ownership !== 'library'
  )
}

/** Native discovery excludes managed targets; copies retain only actual owned source metadata. */
export function skillagerProjectRows(
  data: SkillagerMetadataResult,
  canonical: SkillagerCanonicalObservation = {
    rows: canonicalSkillagerMetadata(data.rows),
    checkedAt: data.checkedAt,
    freshness: 'fresh',
  },
): readonly SkillagerMetadata[] {
  const metadata = data.rows.filter(isNativeProjectSkill)
  const owned = canonical.rows
  return [
    ...metadata.map((row) => ({
      ...row,
      workspaceCheckedAt: data.checkedAt,
      workspaceFreshness: 'fresh' as const,
    })),
    ...(data.exposures ?? []).map((exposure) => {
      const key = skillagerSourceKey(exposure.sourceLibraryId, exposure.skillId)
      return {
        ...((key ? owned.get(key) : undefined) ?? unavailableSource(exposure)),
        workspace: exposure,
        workspaceCopies: undefined,
        exposure: exposure.mode,
        workspaceFreshness:
          key && owned.has(key) ? canonical.freshness : ('fresh' as const),
        workspaceCheckedAt: Math.min(
          data.checkedAt,
          canonical.checkedAt ?? data.checkedAt,
        ),
      }
    }),
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

/** Renderer lookup only; canonical association uses the shared public identity value. */
export function canonicalSkillagerMetadata(
  rows: readonly SkillagerMetadata[],
): ReadonlyMap<string, SkillagerMetadata> {
  const result = new Map<string, SkillagerMetadata>()
  for (const row of rows) {
    const key = skillagerSourceKey(row.source.libraryId, row.id)
    if (key && row.source.ownership === 'library' && !row.workspace) result.set(key, row)
  }
  return result
}

function unavailableOccurrence(
  metadata: SkillagerMetadata,
  canonical: ReadonlyMap<string, SkillagerMetadata>,
  checkedAt: number,
  message?: string,
): SkillagerMetadata {
  const key = skillagerSourceKey(metadata.source.libraryId, metadata.id)
  const source = key ? canonical.get(key) : undefined
  return {
    ...metadata,
    ...source,
    workspace: metadata.workspace,
    workspaceCopies: undefined,
    routerMembership: metadata.routerMembership,
    workspaceFreshness: 'unavailable',
    workspaceCheckedAt: checkedAt,
    description: message ?? source?.description ?? metadata.description,
  }
}
