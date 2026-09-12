import { hostPathEquals, joinHostPath, localPath } from '../../shared/host-path'
import type { SkillagerLibraryStatus } from './skillager-setup-port'
import { SkillagerError } from './skillager-port'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed()
  return value as Record<string, unknown>
}
function malformed(): never {
  throw new SkillagerError(
    'malformed-result',
    'Skillager returned an invalid library setup result.',
  )
}
function path(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.length > 16384 ||
    value.includes('\0')
  )
    return malformed()
  return localPath(value)
}
function ready(data: Record<string, unknown>): SkillagerLibraryStatus {
  const library = record(data.library),
    git = record(data.git)
  if (
    library.schema !== 'skillager.library.v1' ||
    library.namespace !== 'lib' ||
    library.registration !== 'valid' ||
    typeof library.library_id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(library.library_id)
  )
    return malformed()
  const root = path(library.root),
    skillsRoot = path(library.skills_path)
  if (
    !hostPathEquals(skillsRoot, joinHostPath(root, 'skills')) ||
    !['system', 'disabled'].includes(String(git.mode))
  )
    return malformed()
  if (!Array.isArray(data.warnings) || !Array.isArray(data.advisories)) return malformed()
  if (data.warnings.length)
    throw new SkillagerError(
      'unavailable',
      'Skillager reports a library problem. Check library status in your local terminal before connecting.',
    )
  if (git.mode === 'system' && git.repository !== true) return malformed()
  return {
    library: { id: library.library_id, root, skillsRoot },
    gitHistory: git.mode === 'system',
  }
}

/** Only canonical identity and actual history mode survive this boundary. */
export function parseLibraryInitialization(payload: unknown): SkillagerLibraryStatus {
  const data = record(payload)
  if (
    data.schema !== 'skillager.library-init.v1' ||
    !['initialized', 'already-initialized'].includes(String(data.status)) ||
    typeof data.created !== 'boolean' ||
    data.created !== (data.status === 'initialized') ||
    typeof data.git_repository_created !== 'boolean' ||
    !Number.isSafeInteger(data.indexed) ||
    Number(data.indexed) < 0 ||
    !Array.isArray(data.errors)
  )
    return malformed()
  if (data.errors.length)
    throw new SkillagerError(
      'unavailable',
      'Skillager could not index the library completely. Check library status before connecting.',
    )
  return ready(data)
}

export function parseLibraryStatus(payload: unknown): SkillagerLibraryStatus {
  const data = record(payload)
  if (data.schema !== 'skillager.library-status.v1') return malformed()
  if (
    data.status === 'not-initialized' &&
    data.initialized === false &&
    data.library === null &&
    data.git === null
  )
    return {}
  if (data.initialized !== true || !['ready', 'degraded'].includes(String(data.status)))
    return malformed()
  if (data.status !== 'ready')
    throw new SkillagerError(
      'unavailable',
      'Skillager library status is unavailable or degraded. Resolve it in your local terminal, then check status again.',
    )
  return ready(data)
}
