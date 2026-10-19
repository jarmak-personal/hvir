import {
  metadataObject,
  metadataText,
  metadataSourcePath,
  isCanonicalSkillId,
} from './public-metadata.mjs'
import { boundedManagementJson, digest } from './management-contract.mjs'
import { metadataEncoding } from './management-sync-review.mjs'

const libraryId = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)

/** Public exposure metadata only. Selection never invents membership or source identity. */
export function exposureInventory(value, workspace, agent) {
  boundedManagementJson(value)
  if (value?.schema !== 'skillager.exposures.v1' || !Array.isArray(value.exposures))
    throw new Error(
      'Current copies are unavailable. Refresh Project skills or update Skillager.',
    )
  const seen = new Set()
  return value.exposures.map((raw) => {
    const item = metadataObject(raw),
      path = metadataSourcePath(item.target)
    if (
      item.schema !== 'skillager.exposure.v1' ||
      item.agent !== agent ||
      item.scope !== 'project' ||
      !['router', 'native', 'stub'].includes(item.mode) ||
      !path.startsWith(`${workspace.root.path.replace(/\/+$/u, '')}/`) ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      !metadataText(item.exposure_id, 256) ||
      seen.has(path)
    )
      throw new Error('Current copy identities do not match this project and agent.')
    seen.add(path)
    return item
  })
}

export function selectedRouter(exposures, row) {
  const matches = exposures.filter(
    (item) =>
      item.mode === 'router' &&
      `${item.target}/SKILL.md` === row.path &&
      (!row.exposure || item.exposure_id === row.exposure.exposure_id),
  )
  if (matches.length !== 1)
    throw new Error(
      'This Router is no longer available. Refresh Project skills and select it again.',
    )
  const router = matches[0],
    ids = router.skill_ids,
    sources = router.member_sources
  if (
    !Array.isArray(ids) ||
    !Array.isArray(sources) ||
    ids.length !== sources.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !metadataText(id, 256)) ||
    sources.some(
      (item, index) =>
        item?.skill_id !== ids[index] ||
        !(item.source_library_id === null || libraryId(item.source_library_id)),
    )
  )
    throw new Error(
      'Complete Router membership is unavailable. Update Skillager and refresh.',
    )
  return router
}

export async function observeExposures(io, workspace, agent) {
  return exposureInventory(
    await io.run(['expose', '--list', '--agent', agent, '--scope', 'project', '--json']),
    workspace,
    agent,
  )
}

/** Validate the complete selected-original response; the CLI alone proves preservation. */
export function nativePreservation(value, row, workspace, agent, library, code) {
  boundedManagementJson(value)
  if (
    value?.schema !== 'skillager.native-preservation.v1' ||
    !['available', 'ambiguous', 'unavailable'].includes(value.status) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 64 ||
    code !== (value.status === 'unavailable' ? 2 : 0)
  )
    throw new Error(
      'Replacement needs the current public Skillager preservation contract.',
    )
  // Early public refusals can lack resolved context. They can never offer a request.
  if (value.status === 'unavailable' && value.candidates.length === 0) {
    if (
      value.origin &&
      (value.origin.entrypoint !== row.path ||
        value.project !== workspace.root.path ||
        value.agent !== agent)
    )
      throw new Error('Replacement observation belongs to another original or project.')
    return value
  }
  const origin = value.origin
  if (
    value.project !== workspace.root.path ||
    value.agent !== agent ||
    value.scope !== 'project' ||
    value.library_id !== library.id ||
    origin?.entrypoint !== row.path ||
    origin.path !== row.path.slice(0, -9) ||
    origin.native?.agent !== agent ||
    origin.native?.scope !== 'project' ||
    origin.native?.project_root !== workspace.root.path
  )
    throw new Error(
      'Replacement observation does not match this original, library and project.',
    )
  digest(origin.origin_id)
  const seen = new Set()
  let available = 0
  for (const item of value.candidates) {
    if (
      item?.source?.library_id !== library.id ||
      !isCanonicalSkillId(item.source.skill_id) ||
      seen.has(item.source.skill_id) ||
      !['accepted-import', 'approved-sync'].includes(item.basis) ||
      !['available', 'unavailable'].includes(item.status)
    )
      throw new Error(
        'Complete replacement choices have invalid or repeated source identities.',
      )
    seen.add(item.source.skill_id)
    if (item.status === 'unavailable') {
      if (item.requests !== null || !metadataText(item.reason_code, 256))
        throw new Error('Unavailable replacement choice has no complete refusal.')
      continue
    }
    available++
    digest(item.proof_id)
    if (
      item.reason_code !== null ||
      !item.requests ||
      Object.keys(item.requests).sort().join(',') !== 'native,stub'
    )
      throw new Error('Complete replacement requests are unavailable.')
    for (const mode of ['native', 'stub']) {
      const expected = {
        schema: 'skillager.exposure-request.v1',
        action: 'adopt-native',
        origin_id: origin.origin_id,
        source: item.source,
        mode,
      }
      if (metadataEncoding(item.requests[mode]) !== metadataEncoding(expected))
        throw new Error(
          'Replacement request differs from the selected preservation choice.',
        )
    }
  }
  if (
    value.status !==
    (available > 1 ? 'ambiguous' : available ? 'available' : 'unavailable')
  )
    throw new Error('Replacement availability disagrees with its complete choices.')
  return value
}

export async function observeNative(io, row, workspace, agent, library) {
  let code
  const value = await io.run(
    [
      'expose',
      '--observe-native',
      row.path,
      '--agent',
      agent,
      '--scope',
      'project',
      '--json',
    ],
    undefined,
    true,
    (_value, exit) => {
      code = exit
    },
  )
  return nativePreservation(value, row, workspace, agent, library, code)
}
