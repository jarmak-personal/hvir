import { absoluteLocalPath } from './management-contract.mjs'

function selector(value, library = false) {
  if (
    typeof value !== 'string' ||
    !(library ? /^lib\/[\w.-]+$/u : /^[\w.-]+$/u).test(value)
  )
    throw new Error('Select one exact public library skill or managed exposure identity')
  return value
}
function token(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('An exact public confirmation token is required')
  return value
}
function agent(value) {
  if (!['codex', 'claude'].includes(value)) throw new Error('Choose Codex or Claude')
  return value
}
export function initializationArgs(selection) {
  if (selection.root?.hostId !== 'local')
    throw new Error('Choose an explicit local library location')
  if (typeof selection.git !== 'boolean') throw new Error('Choose Git history explicitly')
  return [
    'library',
    'init',
    '--path',
    absoluteLocalPath(selection.root.path).path,
    ...(selection.git ? [] : ['--no-git']),
    '--json',
  ]
}
export function syncArgs(library, apply = false) {
  if (!/^[a-f0-9-]{36}$/u.test(library.id))
    throw new Error('Observe the registered library identity')
  return [
    'library',
    'sync',
    apply ? '--approved' : '--status',
    '--expected-library-id',
    library.id,
    '--expected-library-root',
    absoluteLocalPath(library.root.path).path,
    '--json',
  ]
}
export function exposureArgs(request, confirmation) {
  if (!['native', 'stub'].includes(request.mode)) throw new Error('Choose Full or Stub')
  return [
    'expose',
    selector(request.source.id, true),
    '--agent',
    agent(request.agent),
    '--scope',
    'project',
    '--mode',
    request.mode,
    ...(request.exposureId ? ['--exposure-id', selector(request.exposureId)] : []),
    '--json',
    ...(confirmation
      ? ['--yes', '--confirmation-token', token(confirmation)]
      : ['--dry-run']),
  ]
}
export function removalArgs(request, confirmation) {
  return [
    'expose',
    '--remove',
    selector(request.exposureId),
    '--agent',
    agent(request.agent),
    '--scope',
    'project',
    '--json',
    ...(confirmation
      ? ['--yes', '--confirmation-token', token(confirmation)]
      : ['--dry-run']),
  ]
}
export function acceptanceArgs(skillId, confirmation) {
  return [
    'library',
    'accept',
    selector(skillId, true),
    '--review-manifest',
    '--json',
    ...(confirmation ? ['--yes', '--confirmation-token', token(confirmation)] : []),
  ]
}
