/* global TextEncoder */
import { metadataObject as object, metadataText as text } from './public-metadata.mjs'

export const MANAGEMENT_LIMITS = { responseBytes: 256 * 1024, effects: 512 }
export function boundedManagementResult(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 6144)
    throw new Error(
      'Complete operation result exceeds the action bound. Native effects require explicit reconciliation; no partial result is claimed.',
    )
  return value
}
export function boundedManagementJson(value) {
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    MANAGEMENT_LIMITS.responseBytes
  )
    throw new Error(
      'Complete operation metadata exceeds the supported review bound. Use the public Skillager CLI, then Refresh; no partial plan was applied.',
    )
  return value
}
export function absoluteLocalPath(value) {
  const path = text(value)
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Choose an explicit absolute local path without parent components')
  return { hostId: 'local', path: path.replace(/\/+$/u, '') || '/' }
}
export function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('Required exact public hash/token is unavailable')
  return value
}
export function registeredLibrary(value) {
  const status = object(boundedManagementJson(value))
  if (status.schema !== 'skillager.library-status.v1' || status.initialized !== true)
    throw new Error(
      'Observe an initialized personal library before connecting or changing it',
    )
  const library = object(status.library)
  if (
    library.registration !== 'valid' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      library.library_id,
    ) ||
    !['system', 'disabled'].includes(status.git?.mode)
  )
    throw new Error(
      'Registered library identity or history is unavailable; reconcile through public Skillager status',
    )
  return {
    id: library.library_id,
    root: absoluteLocalPath(library.root),
    gitMode: status.git.mode,
  }
}
export function sameLibrary(expected, observed) {
  if (
    expected.id !== observed.id ||
    expected.root.hostId !== 'local' ||
    observed.root.hostId !== 'local' ||
    expected.root.path !== observed.root.path
  )
    throw new Error(
      'Personal library connection changed; observe and explicitly connect again',
    )
}
export function initializationResult(value, status, selection) {
  const result = object(boundedManagementJson(value)),
    observed = registeredLibrary(status)
  if (
    result.schema !== 'skillager.library-init.v1' ||
    !['initialized', 'already-initialized'].includes(result.status) ||
    typeof result.created !== 'boolean' ||
    !Array.isArray(result.errors) ||
    result.errors.length ||
    result.library?.registration !== 'valid' ||
    result.library.library_id !== observed.id ||
    result.library.root !== observed.root.path ||
    result.git?.mode !== observed.gitMode
  )
    throw new Error(
      'Initialization may have registered files, but its complete result/status could not be verified. Reconcile public status before retrying.',
    )
  const desired = selection.git ? 'system' : 'disabled'
  return {
    observed,
    created: result.created === true,
    connect:
      selection.location === 'default' ||
      (selection.location === 'custom' &&
        selection.root.hostId === 'local' &&
        absoluteLocalPath(selection.root.path).path === observed.root.path &&
        desired === observed.gitMode),
    message:
      result.created === true
        ? 'Personal library created'
        : 'Existing personal library registered; its history mode was preserved',
  }
}
export function acceptedSource(value, library, id, expectedHash) {
  const data = object(boundedManagementJson(value))
  sameLibrary(library, registeredLibrary(data))
  const skill = object(data.skill)
  if (
    skill.id !== id ||
    skill.acceptance !== 'accepted' ||
    !skill.accepted_hash ||
    skill.working_hash !== skill.accepted_hash
  )
    throw new Error(
      'The selected current canonical source needs exact review and acceptance. Reading remains available; Refresh after acceptance.',
    )
  const hash = digest(skill.accepted_hash)
  if (expectedHash !== undefined && hash !== digest(expectedHash))
    throw new Error(
      'Selected accepted version changed; Refresh and choose that version explicitly',
    )
  return { id, hash, root: absoluteLocalPath(skill.path) }
}
function workspacePath(workspace) {
  if (
    workspace?.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    typeof workspace.id !== 'string'
  )
    throw new Error('This operation requires the exact local registered project/worktree')
  return absoluteLocalPath(workspace.root.path).path
}
export function fileState(value, generated = false) {
  if (value === null) return
  const state = object(value)
  if (
    !Number.isSafeInteger(state.mode) ||
    state.mode < 0 ||
    state.mode > 0o7777 ||
    !['file', 'directory'].includes(state.type)
  )
    throw new Error(
      'Complete effects contain an unsupported file kind; preserve the target and use ordinary file tools',
    )
  if (
    state.type === 'file' &&
    !state.metadata &&
    (!Number.isSafeInteger(state.size) || state.size < 0 || !digest(state.sha256))
  )
    throw new Error('Complete file byte identity is unavailable')
  if (state.metadata) {
    if (!generated || state.type !== 'file')
      throw new Error('Generated metadata appeared outside its public sidecar effect')
    object(state.metadata)
    object(state.generated_fields)
  }
}
function effects(preview) {
  const values = preview.file_effects
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MANAGEMENT_LIMITS.effects
  )
    throw new Error(
      'Complete file effects are unavailable or exceed the supported review bound; no partial plan was applied',
    )
  const paths = new Set()
  for (const effect of values) {
    const path = text(effect.path)
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(path) ||
      !['create', 'replace', 'remove'].includes(effect.action)
    )
      throw new Error('Complete effect paths are invalid or repeated')
    paths.add(path)
    fileState(effect.before)
    fileState(effect.after, path === 'skillager.materialized.yaml')
    if (
      (effect.action === 'create' && (effect.before !== null || effect.after === null)) ||
      (effect.action === 'replace' &&
        (effect.before === null || effect.after === null)) ||
      (effect.action === 'remove' && (effect.before === null || effect.after !== null))
    )
      throw new Error('Complete before/after effects disagree with the operation')
  }
  return values
}
function targetPath(target, request) {
  const project = workspacePath(request.workspace),
    path = absoluteLocalPath(target).path
  const folder =
    request.agent === 'codex'
      ? '.agents'
      : request.agent === 'claude'
        ? '.claude'
        : undefined
  if (
    !folder ||
    !path.startsWith(`${project}/${folder}/skills/`) ||
    (request.target &&
      (request.target.hostId !== 'local' || request.target.path !== path))
  )
    throw new Error(
      'Preview destination differs from the selected local project, agent or managed target',
    )
  return path
}
/** Validate public facts; Skillager alone computes tree hashes, eligibility and tokens. */
export function exposurePreview(value, request, createOnly = false) {
  boundedManagementJson(value)
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('One exact complete exposure preview is required')
  const result = object(value[0])
  if (
    result.schema !== 'skillager.exposure-result.v1' ||
    result.status !== 'would_expose'
  )
    throw new Error(
      'Supported complete exposure preview is unavailable; preserve the existing target and observe its current status',
    )
  const preview = object(result.preview)
  if (
    preview.schema !== 'skillager.exposure-preview.v1' ||
    preview.scope !== 'project' ||
    result.scope !== 'project' ||
    preview.agent !== request.agent ||
    result.agent !== request.agent ||
    preview.mode !== request.mode ||
    result.mode !== request.mode ||
    preview.project !== workspacePath(request.workspace) ||
    result.skill_id !== request.source.id ||
    result.target !== preview.target
  )
    throw new Error(
      'Supported complete exposure preview is unavailable; preserve the existing target and observe its current status',
    )
  const source = object(preview.source),
    provenance = object(source.source)
  if (
    source.id !== request.source.id ||
    source.content_hash !== request.source.hash ||
    source.root !== request.source.root.path ||
    !['reviewed', 'trusted', 'pinned'].includes(source.trust) ||
    provenance.ownership !== 'library' ||
    provenance.library_id !== request.library.id ||
    provenance.library_root !== request.library.root.path
  )
    throw new Error(
      'Preview no longer names the selected accepted library identity/version',
    )
  if (
    request.exposureId &&
    (result.exposure_id !== request.exposureId ||
      preview.selected_exposure_id !== request.exposureId)
  )
    throw new Error('Preview substituted a different managed copy')
  targetPath(preview.target, request)
  const files = effects(preview),
    token = digest(preview.confirmation_token)
  if (createOnly) {
    if (
      preview.target_state_hash !== null ||
      preview.target_directory?.before_mode !== null ||
      files.some((effect) => effect.action !== 'create')
    )
      throw new Error(
        'Add requires an absent target and exact create-only plan. Review an existing copy separately.',
      )
  } else digest(preview.target_state_hash)
  return { result, preview, token, target: preview.target, effects: files }
}
export function removalPreview(value, request) {
  const data = object(boundedManagementJson(value))
  if (
    data.schema !== 'skillager.exposure-remove.v1' ||
    !Array.isArray(data.results) ||
    data.results.length !== 1
  )
    throw new Error('One complete managed removal preview is required')
  const result = object(data.results[0]),
    preview = object(result.preview)
  if (
    result.status !== 'would_remove' ||
    result.exposure_id !== request.exposureId ||
    result.agent !== request.agent ||
    result.scope !== 'project' ||
    preview.schema !== 'skillager.exposure-remove-preview.v1'
  )
    throw new Error('Removal no longer names the selected managed copy')
  targetPath(result.target, request)
  if (
    result.requires_force !== false ||
    result.local_changes !== false ||
    result.current_status !== 'current'
  )
    throw new Error(
      'This managed copy has local changes. Preserve them with ordinary file tools; forced removal is unavailable.',
    )
  digest(preview.target_state_hash)
  const files = effects(preview)
  if (
    files.some((effect) => effect.action !== 'remove') ||
    preview.target_directory?.after_mode !== null
  )
    throw new Error('Removal effects contain another operation')
  const argv = result.next_command_argv
  if (!Array.isArray(argv) || argv.at(-2) !== '--confirmation-token')
    throw new Error('Removal confirmation token is unavailable')
  return {
    result,
    preview,
    token: digest(argv.at(-1)),
    target: result.target,
    effects: files,
  }
}
