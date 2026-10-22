/* global TextEncoder */
import {
  metadataObject as object,
  metadataText as text,
  metadataSourcePath as sourcePath,
  isCanonicalSkillId,
} from './public-metadata.mjs'
import {
  SkillagerSetupError,
  projectInventoryRequirement,
  projectQueryRequirement,
} from './library-first-use.mjs'
import { sourcePresentation } from './library-source-catalog.mjs'
export const MINIMUM_SKILLAGER = '0.9.3'
export function requireVersion(text) {
  const match = /skillager\s+(\d+)\.(\d+)\.(\d+)/u.exec(text)
  if (
    !match ||
    (Number(match[1]) === 0 &&
      (Number(match[2]) < 9 || (Number(match[2]) === 9 && Number(match[3]) < 3)))
  )
    throw new SkillagerSetupError(
      'update-required',
      `Skillager ${MINIMUM_SKILLAGER} or newer is required. Use the supported official current source and choose Connect Skillager.`,
    )
}
export function libraryStatus(value) {
  const data = object(value)
  if (data.schema !== 'skillager.library-status.v1')
    throw new SkillagerSetupError(
      'update-required',
      'Required public contract skillager.library-status.v1 is missing. Install the current supported Skillager source; version alone does not establish support.',
    )
  if (!data.initialized) return { initialized: false, count: 0 }
  const library = object(data.library)
  if (library.registration !== 'valid')
    throw new Error(
      'Personal library registration is unavailable; repair it in Skillager',
    )
  return {
    initialized: true,
    id: text(library.library_id, 80),
    root: text(library.root),
    count: data.counts?.skills ?? null,
  }
}
function listEnvelope(value, scope) {
  const data = object(value)
  if (
    data.schema !== 'skillager.list.v1' ||
    data.scope !== scope ||
    !Array.isArray(data.skills) ||
    data.skills.length > 100 ||
    !(
      data.next_cursor === null ||
      (typeof data.next_cursor === 'string' && data.next_cursor.length <= 4096)
    )
  )
    throw new SkillagerSetupError(
      'update-required',
      scope === 'project'
        ? projectInventoryRequirement
        : 'Required public contract skillager.list.v1 is missing or invalid. Skillager ≥0.9.3 with the current public library contract is required; no legacy fallback is used.',
    )
  return data
}
export function libraryPage(value) {
  const data = listEnvelope(value, 'library')
  return {
    rows: data.skills.map((item) => {
      const row = object(item)
      return {
        id: text(row.id, 256),
        name: text(row.name, 256),
        description: row.description === null ? '' : text(row.description, 1000),
        status: text(row.status, 80),
        path: sourcePath(row.skill_file),
        source: 'library',
        host: 'local',
        kind: 'Your library',
        ...sourcePresentation(row.source_group),
      }
    }),
    next: data.next_cursor,
  }
}
export function searchPage(value, workspace) {
  const data = object(value)
  if (
    data.schema !== 'skillager.search.v1' ||
    data.status !== 'completed' ||
    !Array.isArray(data.results) ||
    data.results.length > 100 ||
    !(
      data.next_cursor === null ||
      (typeof data.next_cursor === 'string' && data.next_cursor.length <= 4096)
    )
  )
    throw new SkillagerSetupError(
      'update-required',
      `Required public contract skillager.search.v1 is unavailable${data.reason_code ? `: ${data.reason_code}` : ''}. Install the current supported Skillager source; no legacy search fallback is used.`,
    )
  return {
    rows: data.results.map((item) => {
      const row = object(item),
        search = object(row.search),
        occurrence = object(search.occurrence)
      const installed = occurrence.kind !== 'library'
      if (installed && !localWorkspace(workspace))
        throw new Error(
          'Unsupported installed occurrence; presence is unknown, no source was relabeled',
        )
      if (installed && data.context?.project_root !== workspace.root.path)
        throw new Error(
          'Installed observation does not match the selected local workspace',
        )
      return {
        host: 'local',
        ...(installed ? { workspaceId: workspace.id } : {}),
        id: text(occurrence.id, 256),
        skillId: text(row.id, 256),
        name: text(row.name ?? row.summary ?? row.id, 256),
        description: text(row.description ?? row.summary ?? '', 1000),
        status: text(row.trust ?? 'observed', 80),
        path: sourcePath(occurrence.entrypoint),
        source: occurrence.kind === 'library' ? 'library' : 'project',
        kind:
          occurrence.kind === 'library'
            ? 'Your library'
            : occurrence.kind === 'stub'
              ? 'Installed Stub'
              : occurrence.kind === 'router-member'
                ? 'Installed Router'
                : occurrence.kind === 'full'
                  ? 'Installed Full'
                  : 'Project original',
        canonical: validCanonical(search.canonical) ? search.canonical : null,
        matched: search.match?.skill_id ?? null,
        ...sourcePresentation(row.source_group),
        installed: search.installed,
        ...(['codex', 'claude'].includes(occurrence.agent)
          ? { agent: occurrence.agent }
          : {}),
      }
    }),
    next: data.next_cursor,
    policy: data.policy,
    presence: data.context?.installed_observation ?? 'unknown',
  }
}
/** This command owns argparse's unsupported project inventory and filtering facts. */
export function projectInventoryFailure(error) {
  if (error.cli?.outcome !== 'completed' || error.cli.code !== 2) return error
  if (/unrecognized arguments: --query(?: |$)/u.test(error.cli.stderr))
    return new SkillagerSetupError('update-required', projectQueryRequirement)
  if (/argument --scope: invalid choice: ['"]project['"]/u.test(error.cli.stderr))
    return new SkillagerSetupError('update-required', projectInventoryRequirement)
  return error
}
/** Project membership and copy identity are observed by Skillager, never inferred here. */
export function projectInventory(value, workspace) {
  if (!localWorkspace(workspace))
    throw new Error('Project presence is unknown without an exact local workspace')
  const data = listEnvelope(value, 'project')
  if (data.project_root !== workspace.root.path)
    throw new Error('Project inventory does not match the selected local workspace')
  const observation = object(data.observation)
  if (
    !['complete', 'partial'].includes(observation.status) ||
    !Array.isArray(observation.errors) ||
    observation.errors.length > 20 ||
    !Number.isSafeInteger(observation.error_count) ||
    observation.error_count < observation.errors.length ||
    (observation.status === 'complete' && observation.error_count !== 0) ||
    (observation.status === 'partial' && observation.error_count === 0)
  )
    throw new Error('Skillager could not complete this project observation')
  const errors = observation.errors.map((item) => {
    const error = object(item)
    return `${text(error.code, 80)}${error.path === null ? '' : ` · ${text(error.path)}`}`
  })
  const identities = new Set()
  return {
    rows: data.skills.map((item) => {
      const row = object(item),
        native = object(row.native),
        path = sourcePath(row.skill_file)
      const id = text(row.occurrence_id, 256),
        managed = row.kind !== 'native'
      if (
        !['native', 'full', 'stub', 'router'].includes(row.kind) ||
        native.scope !== 'project' ||
        native.managed !== managed ||
        !path.startsWith(`${workspace.root.path.replace(/\/+$/u, '')}/`) ||
        path.split('/').some((part) => part === '.' || part === '..') ||
        identities.has(id) ||
        (!managed &&
          (!['pending', 'accepted', 'blocked', 'lint_blocked'].includes(row.status) ||
            row.exposure !== null)) ||
        (managed && (row.status !== 'present' || row.trust !== null))
      )
        throw new Error('Skillager returned an invalid project occurrence')
      identities.add(id)
      const observedExposure = managed ? object(row.exposure) : undefined
      const exposure = observedExposure && {
        exposure_id: text(observedExposure.exposure_id, 256),
        skill_id: text(observedExposure.skill_id, 256),
        target: sourcePath(observedExposure.target),
        agent: text(observedExposure.agent, 80),
        scope: observedExposure.scope,
        mode: observedExposure.mode,
        ...(row.kind === 'router'
          ? {}
          : {
              source_library_id: sourceLibraryId(observedExposure.source_library_id),
            }),
      }
      if (
        exposure &&
        (observedExposure.schema !== 'skillager.exposure.v1' ||
          !exposure.exposure_id ||
          !exposure.agent ||
          exposure.skill_id !== row.id ||
          exposure.scope !== 'project' ||
          exposure.agent !== native.agent ||
          `${exposure.target}/SKILL.md` !== path ||
          exposure.mode !== (row.kind === 'full' ? 'native' : row.kind))
      )
        throw new Error('Managed project occurrence does not match its exposure')
      const canonical = exposure && {
        library_id: exposure.source_library_id,
        skill_id: exposure.skill_id,
      }
      return {
        id,
        skillId: text(row.id, 256),
        name: text(row.name, 256),
        description: row.description === null ? '' : text(row.description, 1000),
        status: text(row.status, 80),
        path,
        source: 'project',
        host: 'local',
        workspaceId: workspace.id,
        ...(['codex', 'claude'].includes(native.agent) ? { agent: native.agent } : {}),
        ...(exposure ? { exposure } : {}),
        kind:
          row.kind === 'native'
            ? 'Project original'
            : row.kind === 'stub'
              ? 'Installed Stub'
              : row.kind === 'router'
                ? 'Installed Router'
                : 'Installed Full',
        canonical: validCanonical(canonical) ? canonical : null,
      }
    }),
    next: data.next_cursor,
    coverage: observation.status,
    detail: `${observation.error_count} observation issue${observation.error_count === 1 ? '' : 's'}${errors.length ? `\n${errors.join('\n')}` : ''}`,
  }
}
function sourceLibraryId(value) {
  if (value === null || validLibraryId(value)) return value
  throw new Error('Managed project occurrence has an invalid source library identity')
}
export function searchArgs(
  query,
  {
    cursor = '',
    includeInstalled = false,
    separateCopies = false,
    preferredAgent,
    installedProject,
  } = {},
) {
  const args = [
    'search',
    query,
    '--scope',
    'library',
    '--view',
    separateCopies ? 'copies' : 'skills',
    '--json',
    '--limit',
    '50',
    '--cursor',
    cursor,
    '--no-session-record',
  ]
  // No installed-project means personal candidates only, with unknown presence.
  // The CLI needs this flag to avoid claiming/excluding unknown installed identities.
  if (!installedProject || includeInstalled) args.push('--include-installed')
  if (preferredAgent) args.push('--agent', preferredAgent)
  if (installedProject) args.push('--installed-project', installedProject)
  return args
}

let selectionSerial = 0
/** The observed entrypoint's containing folder, without inferring another occurrence. */
export function occurrenceFolder(row) {
  const path = sourcePath(row.path)
  return { hostId: row.host, path: path.slice(0, path.lastIndexOf('/')) || '/' }
}
/** Descriptions and unused observations never enter an instruction selection. */
export function detailInputFor(row, library) {
  if (row.host !== 'local' || (row.source === 'project' && !row.workspaceId))
    throw new Error('Selected source lacks an exact observing host/workspace')
  const identity = {
    id: row.id,
    ...(row.skillId ? { skillId: row.skillId } : {}),
    path: row.path,
    source: row.source,
    host: row.host,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.agent ? { agent: row.agent } : {}),
    ...(validCanonical(row.canonical) ? { canonical: row.canonical } : {}),
    ...(row.exposure ? { exposure: row.exposure } : {}),
  }
  const input = {
    selection: `${Date.now()}-${++selectionSerial}`,
    row: identity,
    ...(row.source === 'library' && library?.initialized
      ? { library: { id: library.id, root: library.root } }
      : {}),
  }
  if (new TextEncoder().encode(JSON.stringify(input)).length > 6144 && input.library)
    delete input.library.root
  if (new TextEncoder().encode(JSON.stringify(input)).length > 6144)
    throw new Error(
      'Selected source identity exceeds the public detail-input byte bound; no path was truncated or substituted',
    )
  return input
}

function validCanonical(value) {
  return value && validLibraryId(value.library_id) && isCanonicalSkillId(value.skill_id)
}
function validLibraryId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
  )
}

export function localWorkspace(workspace) {
  return workspace?.host === 'local' &&
    workspace.root?.hostId === 'local' &&
    typeof workspace.root.path === 'string'
    ? workspace
    : undefined
}
