import { exactImportIdentity, importArgs } from './import-contract.mjs'
import {
  absoluteLocalPath,
  boundedManagementJson,
  digest,
} from './management-contract.mjs'
import { exactExposureTargets, exactTargetResults } from './exposure-contract.mjs'
import { metadataEncoding } from './management-sync-review.mjs'

export const placementUpdate =
  'Update Skillager to use Full or Stub for this skill. Reading and Save to library remain available.'
const schema = 'skillager.import-placement.v1'
const same = (a, b) => metadataEncoding(a) === metadataEncoding(b)
export function importPlacementArgs(input, token) {
  if (
    !['codex', 'claude'].includes(input.agent) ||
    !['native', 'stub'].includes(input.mode)
  )
    throw new Error('Choose Full or Stub for this original’s Codex or Claude location.')
  const args = importArgs(input)
  args.splice(
    args.indexOf('--json'),
    0,
    '--project-mode',
    input.mode,
    '--agent',
    input.agent,
  )
  return [...args, ...(token ? ['--yes', '--confirmation-token', digest(token)] : [])]
}
export function placementPayload(value) {
  return Object.fromEntries(
    [
      'schema',
      'project',
      'agent',
      'mode',
      'import',
      'library_identity',
      'original',
      'source_decision_state',
      'replacement',
    ].map((key) => [key, value[key]]),
  )
}
/** A prospective compound review is never an accepted exposure-plan witness. */
function placementIdentity(value, input, workspace) {
  boundedManagementJson(value)
  importPlacementArgs(input)
  if (value?.schema !== schema) throw new Error(placementUpdate)
  const identity = exactImportIdentity(value.import, input, workspace)
  const { manifest } = identity,
    original = value.original,
    library = value.library_identity
  if (
    value.project !== workspace.root.path ||
    value.agent !== input.agent ||
    value.mode !== input.mode ||
    original?.entrypoint !== input.file.path ||
    original.path !== manifest.source_root ||
    original.skill_id !== input.skillId ||
    original.native?.agent !== input.agent ||
    original.native?.scope !== 'project' ||
    original.native?.project_root !== workspace.root.path ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(library?.library_id) ||
    library.status !==
      (manifest.library.library_id === null ? 'will-create' : 'existing') ||
    (manifest.library.library_id !== null &&
      library.library_id !== manifest.library.library_id) ||
    Object.hasOwn(manifest, 'confirmation_token') ||
    Object.hasOwn(value.import, 'next_command_argv')
  )
    throw new Error(
      'The complete original, library or project choice changed. Review this skill again.',
    )
  digest(original.origin_id)
  digest(value.source_decision_state)
  const expected = {
    schema: 'skillager.exposure-request.v1',
    action: 'adopt-native',
    origin_id: original.origin_id,
    source: { library_id: library.library_id, skill_id: manifest.destination_id },
    mode: input.mode,
  }
  if (!same(value.replacement?.request, expected))
    throw new Error(
      'Replacement does not match the selected original and saved library version.',
    )
  const targets = exactExposureTargets(value.replacement.targets, workspace)
  const changed = targets.filter((item) => item.kind !== 'parent')
  if (
    changed.length !== 1 ||
    changed[0].kind !== 'direct' ||
    changed[0].path !== original.path ||
    changed[0].action !== 'replace' ||
    changed[0].skill_id !== manifest.destination_id ||
    changed[0].mode !== input.mode ||
    targets.some(
      (item) =>
        item.kind === 'parent' &&
        (!original.path.startsWith(`${item.path}/`) ||
          !['keep', 'create'].includes(item.action)),
    )
  )
    throw new Error(
      'The complete replacement effects differ from this selected original.',
    )
  const staging = value.replacement.staging
  if (
    !staging ||
    [
      'candidate_bytes',
      'retained_original_bytes',
      'transfer_reserve_bytes',
      'peak_bytes',
      'limit_bytes',
    ].some((key) => !Number.isSafeInteger(staging[key]) || staging[key] < 0) ||
    staging.peak_bytes > staging.limit_bytes
  )
    throw new Error('Complete replacement staging bounds are unavailable.')
  return { ...identity, value }
}
export function exactImportPlacement(value, input, workspace) {
  boundedManagementJson(value)
  if (value?.schema !== schema) throw new Error(placementUpdate)
  if (value.status === 'refused')
    throw new Error(
      `${value.error?.message ?? 'Skillager could not preserve and replace this original.'} The original was not replaced. Resolve this conflict and review again.`,
    )
  const identity = placementIdentity(value, input, workspace)
  if (value.status !== 'preview')
    throw new Error('Request a current Save and use review.')
  digest(value.confirmation_token)
  const eligible =
    value.import.blocked === false &&
    value.import.requires_override === false &&
    same(value.next_command_argv, [
      'skillager',
      ...importPlacementArgs({ ...input, name: identity.name }, value.confirmation_token),
    ])
  return {
    ...identity,
    eligible,
    gate: eligible
      ? undefined
      : 'Skillager cannot save and use this version. Resolve its reported source restrictions before reviewing again.',
  }
}
export async function prepareImportPlacement(io, input, workspace) {
  let value
  try {
    value = await io.run(
      importPlacementArgs(input),
      undefined,
      true,
      (reply, code, stderr) => {
        if (
          typeof reply?.schema === 'string' &&
          reply.schema.startsWith('skillager.import-placement.') &&
          reply.schema !== schema
        )
          throw new Error(placementUpdate)
        if (![0, 2].includes(code) || reply?.schema !== schema) {
          const cause =
            typeof reply?.error?.message === 'string'
              ? reply.error.message.slice(0, 300)
              : stderr
          throw new Error(
            `Skillager could not prepare this skill (exit ${code ?? 'unknown'})${cause ? `: ${cause}` : '.'}`,
          )
        }
        if (code === 2 && reply.status !== 'refused')
          throw new Error(
            'Skillager returned an incomplete preparation result. Refresh this skill before continuing.',
          )
      },
    )
  } catch (error) {
    if (
      error.nativeExit === 2 &&
      /unrecognized arguments:[^\n]*--project-mode\b/u.test(error.nativeStderr ?? '')
    )
      throw new Error(placementUpdate, { cause: error })
    throw error
  }
  return exactImportPlacement(value, input, workspace)
}
export function placementCompletion(value, code, preview, input, workspace) {
  boundedManagementJson(value)
  if (value?.schema !== schema || ![0, 2].includes(code))
    throw new Error(
      'The submitted Save and use result is incomplete. Inspect its operation before continuing.',
    )
  const save = value.save,
    placement = value.placement
  if (
    value.status === 'refused' &&
    code === 2 &&
    save?.status === 'not-started' &&
    placement?.status === 'not-started' &&
    !value.initialization &&
    value.error?.code &&
    typeof value.error.message === 'string'
  )
    return value
  placementIdentity(value, input, workspace)
  if (
    !same(placementPayload(value), placementPayload(preview)) ||
    value.plan_hash !== preview.confirmation_token ||
    !['saved-and-replaced', 'saved-not-replaced', 'partial', 'uncertain'].includes(
      value.status,
    ) ||
    !['not-started', 'uncertain', 'accepted'].includes(save?.status) ||
    ![
      'not-started',
      'not-applied',
      'uncertain',
      'applied',
      'refused',
      'partial',
    ].includes(placement?.status)
  )
    throw new Error(
      'The submitted result does not cover the exact reviewed Save and use decision.',
    )
  const manifest = preview.import.review_manifest
  if (
    save.status === 'accepted' &&
    (save.destination?.id !== manifest.destination_id ||
      save.destination.path !== manifest.destination_path ||
      save.destination.working_hash !== manifest.source_hash ||
      save.destination.accepted_hash !== manifest.source_hash ||
      save.destination.acceptance !== 'accepted' ||
      save.approval?.state !== 'reviewed' ||
      save.approval.scope !== 'global' ||
      save.approval.content_hash !== manifest.source_hash ||
      save.copied_file_count !== manifest.file_count)
  )
    throw new Error(
      'The saved canonical version has no complete exact acceptance result.',
    )
  const initialization = value.initialization
  if (
    manifest.library.status === 'will-initialize' &&
    save.status === 'accepted' &&
    (!initialization ||
      !['initialized', 'already-initialized'].includes(initialization.status))
  )
    throw new Error(
      'The accepted save lacks its required library initialization or reconnection result.',
    )
  if (
    initialization &&
    (manifest.library.status !== 'will-initialize' ||
      initialization.root !== manifest.library.root ||
      !['initialized', 'already-initialized', 'uncertain'].includes(
        initialization.status,
      ) ||
      (initialization.status !== 'uncertain' &&
        initialization.library_id !== preview.library_identity.library_id))
  )
    throw new Error(
      'Library initialization or reconnection does not match the reviewed destination.',
    )
  if (['applied', 'refused', 'partial'].includes(placement.status))
    exactTargetResults(placement.results, preview.replacement.targets)
  if (
    placement.status === 'applied' &&
    (save.status !== 'accepted' ||
      placement.results.some(
        (item) =>
          !['applied', 'unchanged'].includes(item.status) || item.recovery_path !== null,
      ))
  )
    throw new Error('Project success disagrees with the saved version or file outcomes.')
  if (
    (value.status === 'saved-and-replaced') !== (code === 0) ||
    (code === 0 && (save.status !== 'accepted' || placement.status !== 'applied')) ||
    (value.status === 'saved-not-replaced' &&
      (save.status !== 'accepted' ||
        !['not-applied', 'refused'].includes(placement.status) ||
        (placement.status === 'refused' &&
          placement.results.some(
            (item) =>
              !['refused', 'unchanged'].includes(item.status) ||
              item.recovery_path !== null,
          ))))
  )
    throw new Error(
      'The operation summary disagrees with its separate save and project results.',
    )
  if (value.cleanup?.path) absoluteLocalPath(value.cleanup.path)
  return value
}
