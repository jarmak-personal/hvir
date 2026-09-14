// Synthetic public search responses. Group/filter before the one result window here;
// this is not hvir's search policy, a CLI implementation or a scale benchmark.
export function readingSearchFixture(curation) {
  const example = curation.sources[0]
  curation.sources = ['merge', 'review', 'release'].map((id, index) => ({
    ...example,
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} guidance`,
    logicalIdentity: `sample-lineage-${id}`,
    description: 'Reusable workflow guidance.',
    agent: index === 1 ? 'claude' : 'codex',
    preserved: true,
    projectPresent: true,
    version: 'original-v1',
    approvedVersion: 'original-v1',
    libraryVersion: 'accepted-v2',
    libraryAcceptedVersion: 'accepted-v2',
    libraryAccepted: true,
    exposedVersion: 'original-v1',
    originalMatch: 'original-only',
    canonicalMatch: 'canonical-only',
  }))
  curation.selected = 'merge'
  curation.selectedScope = 'workspace'
  curation.routers = []
  return curation
}
export function curationSearchCandidates(state) {
  return state.curation.sources.flatMap((row) => {
    const candidates = [],
      identity = row.logicalIdentity ?? null
    if (
      row.preserved &&
      row.libraryAccepted &&
      !row.libraryBlocked &&
      row.libraryVersion === row.libraryAcceptedVersion
    )
      candidates.push({
        ...row,
        resultScope: 'library',
        occurrenceId: `library:${row.id}`,
        sourceVersion: row.libraryVersion,
        identity,
        canonical: true,
        searchText: `${row.name} ${row.description} ${row.canonicalMatch || ''}`,
      })
    if (row.approved && !row.originBlocked && row.version === row.approvedVersion)
      candidates.push({
        ...row,
        resultScope: 'workspace',
        occurrenceId: `original:${row.id}`,
        sourceVersion: row.version,
        identity,
        canonical: false,
        searchText: `${row.name} ${row.description} ${row.originalMatch || ''}`,
      })
    return candidates
  })
}
export function publicSearchSample(state, submitted, candidates) {
  const legacy = submitted.legacy === true
  if (!legacy && state.searchContract === false)
    return {
      rows: [],
      unavailable:
        'This Skillager installation does not support grouped search and installed exclusion.',
      unavailableKind: 'contract',
    }
  if (!legacy && state.presenceUnknown && !submitted.includeInstalled)
    return {
      rows: [],
      unavailable:
        'Installed-skill presence is unavailable. Search including installed skills to retain grouping.',
      unavailableKind: 'presence',
    }
  const eligible = candidates.filter(
    (row) => submitted.scope !== 'personal' || row.resultScope !== 'workspace',
  )
  const query = submitted.query.trim().toLowerCase()
  const matches = (row) =>
    (row.searchText || `${row.id} ${row.description} ${row.tags} ${row.query || ''}`)
      .toLowerCase()
      .includes(query)
  const installed = new Set(
    state.curation
      ? state.curation.sources
          .filter((row) => row.projectPresent && row.logicalIdentity)
          .map((row) => row.logicalIdentity)
      : Object.entries(state.exposures)
          .filter(([key]) => key.startsWith(`${state.destination}/`))
          .flatMap(([, copies]) =>
            Object.keys(copies).map((id) => `library:${state.library.id}:${id}`),
          ),
  )
  const groups = new Map()
  for (const row of eligible) {
    const key = row.identity || row.occurrenceId || row.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const rows = []
  let installedHidden = false
  for (const members of groups.values()) {
    const matched = members.filter(matches)
    if (!matched.length) continue
    if (
      !legacy &&
      !submitted.includeInstalled &&
      members[0].identity &&
      installed.has(members[0].identity)
    ) {
      installedHidden = true
      continue
    }
    const representatives = legacy
      ? matched
      : submitted.showCopies
        ? members
        : [members.find((row) => row.canonical) || matched[0]]
    for (const row of representatives)
      rows.push({
        ...row,
        match: row.query === query ? row.match : 'Metadata',
        matchedOccurrence: matched[0].occurrenceId || matched[0].id,
        matchedSource:
          matched[0].resultScope === 'library'
            ? 'Your library'
            : matched[0].origin || matched[0].source || 'Project original',
        matchedVersion: matched[0].sourceVersion || matched[0].version,
        representativeMatched: matches(row),
        grouped: !legacy && !submitted.showCopies,
        legacy,
      })
  }
  return { rows: rows.slice(0, 50), installedHidden, legacy }
}
export function submittedSearchLabel(submitted) {
  if (!submitted) return ''
  return `${submitted.scope === 'personal' ? 'Your library' : 'Available to this project'} · ${submitted.legacy ? 'Legacy results · Installed included' : `${submitted.includeInstalled ? 'Including installed' : 'Installed hidden'} · ${submitted.showCopies ? 'Separate copies' : 'One per skill'}`} · ${submitted.agent === 'all' ? 'All agents' : submitted.agent === 'claude' ? 'Prefer Claude' : 'Prefer Codex'}`
}
