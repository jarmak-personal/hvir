import { containsHostPath, hostPathEquals } from '../../shared/host-path'
import { SKILLAGER_AGENTS } from '../../shared/skillager'
import type {
  SkillagerLifecycleRequest,
  SkillagerRouterRemovalRequest,
} from '../../shared/skillager-exposure-plan'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import { safeExposureId } from './skillager-exposure-selection'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'

/** Closed selectors carry public identities, never raw commands or writable path grants. */
export function validateLifecycleSelection(
  request: SkillagerLifecycleRequest | SkillagerRouterRemovalRequest,
  selection: SkillagerCliSelection,
): void {
  if (
    request.destination.root.hostId !== 'local' ||
    !hostPathEquals(request.workspaceRoot, request.destination.root) ||
    !SKILLAGER_AGENTS.some((agent) => agent.id === request.agent)
  )
    invalid()
  const confined = (path: import('../../shared/host-path').HostPath) =>
    containsHostPath(request.destination.root, path) &&
    !hostPathEquals(request.destination.root, path)
  if (request.action === 'remove-router') {
    const copy = request.exposure
    if (
      !copy ||
      copy.mode !== 'router' ||
      copy.agent !== request.agent ||
      !safeExposureId(copy.id) ||
      !confined(copy.target)
    )
      invalid()
    return
  }
  const plan = request.plan
  if (
    !plan ||
    Buffer.byteLength(JSON.stringify(plan)) > 65536 ||
    plan.schema !== 'skillager.exposure-request.v1'
  )
    invalid()
  const id = (value: unknown): string => {
    if (typeof value !== 'string') invalid()
    skillagerLibrarySkillRoot(selection.library!, value)
    return value
  }
  const originId = (value: unknown): void => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
  }
  const mode = (value: unknown): void => {
    if (value !== 'native' && value !== 'stub') invalid()
  }
  const library = (value: unknown): void => {
    if (!selection.library || value !== selection.library.id) invalid()
  }
  const keys = (value: object, expected: readonly string[]): void => {
    if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0'))
      invalid()
  }
  if (!boundedArray(request.origins, 128) || !boundedArray(request.exposures, 128))
    invalid()
  const expectedOrigins: string[] = [],
    expectedExposures: string[] = []
  switch (plan.action) {
    case 'adopt-native':
    case 'remove-native':
      keys(plan, [
        'schema',
        'action',
        'origin_id',
        'source',
        ...(plan.action === 'adopt-native' ? ['mode'] : []),
      ])
      keys(plan.source, ['library_id', 'skill_id'])
      library(plan.source.library_id)
      id(plan.source.skill_id)
      originId(plan.origin_id)
      expectedOrigins.push(plan.origin_id)
      if (plan.action === 'adopt-native') mode(plan.mode)
      break
    case 'group':
    case 'set-members': {
      keys(plan, [
        'schema',
        'action',
        'library_id',
        'members',
        'replace',
        ...(plan.action === 'group' ? ['name'] : ['router_id', 'departures']),
      ])
      library(plan.library_id)
      if (
        !boundedArray(plan.members, 64) ||
        new Set(plan.members).size !== plan.members.length
      )
        invalid()
      plan.members.forEach(id)
      if (!boundedArray(plan.replace, 128)) invalid()
      for (const item of plan.replace) {
        if ('origin_id' in item) {
          keys(item, ['origin_id'])
          originId(item.origin_id)
          expectedOrigins.push(item.origin_id)
        } else {
          keys(item, ['exposure_id'])
          if (!safeExposureId(item.exposure_id)) invalid()
          expectedExposures.push(item.exposure_id)
        }
      }
      if (plan.action === 'group') {
        if (
          typeof plan.name !== 'string' ||
          !plan.name.trim() ||
          plan.name.length > 128 ||
          /[\p{Cc}\p{Cf}]/u.test(plan.name) ||
          !plan.members.length
        )
          invalid()
      } else {
        if (!safeExposureId(plan.router_id) || !boundedArray(plan.departures, 64))
          invalid()
        expectedExposures.push(plan.router_id)
        for (const item of plan.departures) {
          keys(item, ['skill_id', 'mode'])
          id(item.skill_id)
          if (item.mode !== 'remove') mode(item.mode)
        }
        if (
          new Set(plan.departures.map((item) => item.skill_id)).size !==
          plan.departures.length
        )
          invalid()
      }
      break
    }
    case 'ungroup':
      keys(plan, ['schema', 'action', 'router_id', 'mode'])
      if (!safeExposureId(plan.router_id)) invalid()
      expectedExposures.push(plan.router_id)
      mode(plan.mode)
      break
    default:
      invalid()
  }
  const sameSet = (actual: readonly string[], expected: readonly string[]) =>
    actual.length === new Set(actual).size &&
    expected.length === new Set(expected).size &&
    [...actual].sort().join('\0') === [...expected].sort().join('\0')
  if (
    !sameSet(
      request.origins.map((item) => item.originId),
      expectedOrigins,
    ) ||
    !sameSet(
      request.exposures.map((item) => item.id),
      expectedExposures,
    )
  )
    invalid()
  for (const origin of request.origins) {
    originId(origin.originId)
    originId(origin.lineageId)
    originId(origin.sourceIdentity)
    id(origin.skillId)
    if (!confined(origin.path)) invalid()
  }
  for (const copy of request.exposures)
    if (
      !safeExposureId(copy.id) ||
      copy.agent !== request.agent ||
      !confined(copy.target)
    )
      invalid()
}
function invalid(): never {
  throw new SkillagerError(
    'invalid-request',
    'Select exact public skill, origin and router identities in the current local project.',
  )
}

function boundedArray(value: unknown, maximum: number): boolean {
  return Array.isArray(value) && value.length <= maximum
}
