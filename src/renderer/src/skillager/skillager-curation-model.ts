import type {
  SkillagerAgent,
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../../../shared/skillager'
import type {
  SkillagerDestination,
  SkillagerExposureMode,
} from '../../../shared/skillager-exposure'
import type {
  SkillagerLifecycleRequest,
  SkillagerNativeSelection,
  SkillagerPlanRequest,
  SkillagerPlanReplacement,
} from '../../../shared/skillager-exposure-plan'
import type { SkillagerSyncStatus } from '../../../shared/skillager-library-sync'
import { skillagerNativeSelector } from './skillager-native-selection'
import { isNativeProjectSkill, skillagerRouterMemberId } from './skillager-model'

export type CurationAction = 'full' | 'stub' | 'group' | 'edit-members' | 'ungroup'
export interface SkillagerCurationChoice {
  readonly name: string
  readonly router?: SkillagerWorkspaceExposure
  readonly members: readonly string[]
  readonly departures: Readonly<Record<string, SkillagerExposureMode | 'remove'>>
  readonly replacements: readonly string[]
  readonly report?: SkillagerSyncStatus
  readonly nativeSelection?: {
    root: SkillagerDestination['root']
    libraryId: string
    select: ReturnType<typeof skillagerNativeSelector>
  }
}
export interface SkillagerReplacementChoice {
  readonly key: string
  readonly label: string
  readonly skillId: string
  readonly origin?: SkillagerNativeSelection
  readonly exposure?: SkillagerWorkspaceExposure
}
/** Deselecting a member also deselects its explicit replacement; other copies remain untouched. */
export function curationMembers(
  choice: SkillagerCurationChoice,
  members: readonly string[],
  replacements: readonly SkillagerReplacementChoice[],
): SkillagerCurationChoice {
  const selected = new Set(members)
  const byKey = new Map(replacements.map((item) => [item.key, item.skillId]))
  return {
    ...choice,
    members,
    replacements: choice.replacements.filter((key) => {
      const id = byKey.get(key)
      // A vanished selected identity must still refuse; only a deliberate member departure clears it.
      return !id || selected.has(id)
    }),
  }
}
export function curationChoice(
  metadata: SkillagerMetadata,
  report?: SkillagerSyncStatus,
  destination?: SkillagerDestination,
  libraryId?: string,
): SkillagerCurationChoice {
  const router =
    metadata.routerMembership ??
    (metadata.workspace?.router ? metadata.workspace : undefined)
  const nativeSelection =
    destination && libraryId
      ? {
          root: destination.root,
          libraryId,
          select: skillagerNativeSelector(report, destination.root, libraryId),
        }
      : undefined
  const native = nativeSelection?.select(metadata)
  return {
    name: '',
    router,
    members:
      router?.router?.skillIds ??
      (native
        ? [native.skillId]
        : metadata.source.ownership === 'library'
          ? [metadata.id]
          : []),
    departures: {},
    replacements: native
      ? [`origin:${native.originId}`]
      : metadata.workspace && !router
        ? [`exposure:${metadata.workspace.id}`]
        : [],
    report,
    nativeSelection,
  }
}
export function replacementChoices(
  rows: readonly SkillagerMetadata[],
  choice: SkillagerCurationChoice,
  destination: SkillagerDestination,
  agent: SkillagerAgent,
  libraryId: string,
): SkillagerReplacementChoice[] {
  return rows.flatMap<SkillagerReplacementChoice>((row) => {
    const copy = row.workspace
    if (
      copy &&
      !copy.router &&
      copy.agent === agent &&
      copy.sourceLibraryId === libraryId &&
      copy.skillId &&
      choice.members.includes(copy.skillId)
    )
      return [
        {
          key: `exposure:${copy.id}`,
          label: `${row.name} · ${copy.mode === 'stub' ? 'Stub' : 'Full'} · ${copy.target.path}`,
          skillId: copy.skillId,
          exposure: copy,
        },
      ]
    const origin = selectedNative(row, choice, destination, libraryId)
    return origin &&
      row.projectSkill?.agent === agent &&
      choice.members.includes(origin.skillId)
      ? [
          {
            key: `origin:${origin.originId}`,
            label: `${row.name} · Native · ${origin.path.path}`,
            skillId: origin.skillId,
            origin,
          },
        ]
      : []
  })
}
export function curationPlan(
  metadata: SkillagerMetadata,
  action: CurationAction | 'remove',
  mode: SkillagerExposureMode,
  choice: SkillagerCurationChoice,
  destination: SkillagerDestination,
  agent: SkillagerAgent,
  libraryId: string,
  rows: readonly SkillagerMetadata[],
): Pick<SkillagerLifecycleRequest, 'plan' | 'origins' | 'exposures'> {
  const schema = 'skillager.exposure-request.v1' as const
  const native = selectedNative(metadata, choice, destination, libraryId)
  if (
    isNativeProjectSkill(metadata) &&
    (action === 'full' || action === 'stub' || action === 'remove')
  ) {
    if (!native)
      throw new Error(
        'The current original has no exact approved preserved library relation. Use Remove in Files… for ordinary recoverable removal.',
      )
    return {
      plan: {
        schema,
        action: action === 'remove' ? 'remove-native' : 'adopt-native',
        origin_id: native.originId,
        source: { library_id: libraryId, skill_id: native.skillId },
        ...(action === 'remove' ? {} : { mode }),
      } as SkillagerPlanRequest,
      origins: [native],
      exposures: [],
    }
  }
  const router = choice.router
  if (metadata.routerMembership && ['full', 'stub', 'remove'].includes(action)) {
    return {
      plan: {
        schema,
        action: 'set-members',
        router_id: metadata.routerMembership.id,
        library_id: libraryId,
        members: metadata.routerMembership.router!.skillIds.filter(
          (id) => id !== skillagerRouterMemberId(metadata),
        ),
        replace: [],
        departures: [
          {
            skill_id: skillagerRouterMemberId(metadata),
            mode: action === 'remove' ? 'remove' : mode,
          },
        ],
      },
      origins: [],
      exposures: [metadata.routerMembership],
    }
  }
  if (action === 'ungroup') {
    if (!router) throw new Error('Select one current project router.')
    return {
      plan: { schema, action: 'ungroup', router_id: router.id, mode },
      origins: [],
      exposures: [router],
    }
  }
  const options = replacementChoices(rows, choice, destination, agent, libraryId)
  const selected = choice.replacements.map((key) => {
    const option = options.find((item) => item.key === key)
    if (!option)
      throw new Error(
        'A selected standalone copy changed. Choose its current identity again.',
      )
    return option
  })
  const replace: SkillagerPlanReplacement[] = selected.map((item) =>
    item.origin
      ? { origin_id: item.origin.originId }
      : { exposure_id: item.exposure!.id },
  )
  const origins = selected.flatMap((item) => (item.origin ? [item.origin] : []))
  const exposures = selected.flatMap((item) => (item.exposure ? [item.exposure] : []))
  if (isNativeProjectSkill(metadata) && !native)
    throw new Error('Preserve and approve the current native version before grouping it.')
  if (router) {
    const departed = router.router!.skillIds.filter((id) => !choice.members.includes(id))
    if (departed.some((id) => !choice.departures[id]))
      throw new Error('Choose Full, Stub or Remove for every departing member.')
    return {
      plan: {
        schema,
        action: 'set-members',
        router_id: router.id,
        library_id: libraryId,
        members: choice.members,
        replace,
        departures: departed.map((skill_id) => ({
          skill_id,
          mode: choice.departures[skill_id]!,
        })),
      },
      origins,
      exposures: [...exposures, router],
    }
  }
  return {
    plan: {
      schema,
      action: 'group',
      name: choice.name,
      library_id: libraryId,
      members: choice.members,
      replace,
    },
    origins,
    exposures,
  }
}

function selectedNative(
  metadata: SkillagerMetadata,
  choice: SkillagerCurationChoice,
  destination: SkillagerDestination,
  libraryId: string,
) {
  const index = choice.nativeSelection
  return index?.libraryId === libraryId &&
    index.root.hostId === destination.root.hostId &&
    index.root.path === destination.root.path
    ? index.select(metadata)
    : undefined
}
