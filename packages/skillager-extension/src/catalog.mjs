/* global TextEncoder */
export const MINIMUM_SKILLAGER = '0.9.3'
export function requireVersion(text) {
  const match = /skillager\s+(\d+)\.(\d+)\.(\d+)/u.exec(text)
  if (
    !match ||
    (Number(match[1]) === 0 &&
      (Number(match[2]) < 9 || (Number(match[2]) === 9 && Number(match[3]) < 3)))
  )
    throw new Error(
      `Skillager ${MINIMUM_SKILLAGER} or newer is required. Configure a supported installed CLI in Settings → Extensions.`,
    )
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Skillager metadata is unavailable')
  return value
}
function text(value, maximum = 4096) {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    new TextEncoder().encode(JSON.stringify(value)).length > maximum * 4 + 2
  )
    throw new Error('Skillager metadata is unavailable')
  return value
}
function sourcePath(value) {
  const path = text(value)
  if (new TextEncoder().encode(JSON.stringify(path)).length > 4098)
    throw new Error(
      'Source path exceeds the 4096-byte encoded identity bound; no path was truncated or substituted',
    )
  return path
}
export function libraryStatus(value) {
  const data = object(value)
  if (data.schema !== 'skillager.library-status.v1')
    throw new Error(
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
export function libraryPage(value) {
  const data = object(value)
  if (
    data.schema !== 'skillager.list.v1' ||
    data.scope !== 'library' ||
    !Array.isArray(data.skills) ||
    data.skills.length > 100 ||
    !(
      data.next_cursor === null ||
      (typeof data.next_cursor === 'string' && data.next_cursor.length <= 4096)
    )
  )
    throw new Error(
      'Required public contract skillager.list.v1 is missing or invalid. Skillager ≥0.9.3 with the current public library contract is required; no legacy fallback is used.',
    )
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
        kind: 'Your library',
      }
    }),
    next: data.next_cursor,
  }
}
export function searchPage(value) {
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
    throw new Error(
      `Required public contract skillager.search.v1 is unavailable${data.reason_code ? `: ${data.reason_code}` : ''}. Install the current supported Skillager source; no legacy search fallback is used.`,
    )
  return {
    rows: data.results.map((item) => {
      const row = object(item),
        search = object(row.search),
        occurrence = object(search.occurrence)
      return {
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
        installed: search.installed,
      }
    }),
    next: data.next_cursor,
    policy: data.policy,
    presence: data.context?.installed_observation ?? 'unknown',
  }
}
export function projectInventory(value) {
  const data = object(value)
  if (
    !Array.isArray(data.selected) ||
    !Array.isArray(data.action?.changed) ||
    data.action.changed.length !== 0
  )
    throw new Error('Public project inventory is unavailable')
  return {
    rows: data.selected.map((item) => {
      const row = object(item)
      return {
        id: text(row.id, 256),
        name: row.name ?? row.id,
        description: row.summary ?? '',
        status: text(row.trust ?? 'observed', 80),
        path: text(row.entrypoint ?? `${text(row.root)}/SKILL.md`),
        source: 'project',
        kind: 'Project original',
      }
    }),
    coverage: 'observed',
  }
}
export function projectExposures(value) {
  const data = object(value)
  if (data.schema !== 'skillager.exposures.v1' || !Array.isArray(data.exposures))
    throw new Error('Public project exposures are unavailable')
  return data.exposures.map((item) => {
    const row = object(item)
    return {
      id: text(row.exposure_id, 256),
      name: row.skill_id ?? row.router_slug ?? 'Router',
      description: `${row.agent} · ${row.mode}`,
      status: row.status ?? 'observed',
      path: `${text(row.target)}/SKILL.md`,
      source: 'project',
      kind:
        row.mode === 'stub'
          ? 'Installed Stub'
          : row.mode === 'router'
            ? 'Installed Router'
            : 'Installed Full',
      canonical:
        row.source_library_id && row.skill_id?.startsWith('lib/')
          ? { library_id: row.source_library_id, skill_id: row.skill_id }
          : null,
    }
  })
}
export function searchArgs(
  query,
  {
    cursor = '',
    includeInstalled = true,
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
  if (includeInstalled) args.push('--include-installed')
  if (preferredAgent) args.push('--agent', preferredAgent)
  if (installedProject) args.push('--installed-project', installedProject)
  return args
}

let selectionSerial = 0
/** Descriptions and unused observations never enter an instruction selection. */
export function detailInputFor(row) {
  const identity = {
    path: row.path,
    source: row.source,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(validCanonical(row.canonical) ? { canonical: row.canonical } : {}),
  }
  const input = { selection: `${Date.now()}-${++selectionSerial}`, row: identity }
  if (new TextEncoder().encode(JSON.stringify(input)).length > 6144)
    throw new Error(
      'Selected source identity exceeds the public detail-input byte bound; no path was truncated or substituted',
    )
  return input
}

function validCanonical(value) {
  return (
    value &&
    typeof value.library_id === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.library_id) &&
    typeof value.skill_id === 'string' &&
    /^lib\/[a-z0-9][a-z0-9._/-]{0,251}$/iu.test(value.skill_id)
  )
}
