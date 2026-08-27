import type {
  SessionsFact,
  SessionsProjectionRow,
  SessionsTerminalHandle,
} from '../../../shared'

export type SessionsOverviewFilter =
  'all' | 'harnesses' | 'shells' | 'attention' | 'working'
export type SessionsOverviewGroup = 'project' | 'workspace' | 'none'
export type SessionsOverviewSort = 'priority' | 'title' | 'project'

export interface SessionsOverviewPolicy {
  readonly filter: SessionsOverviewFilter
  readonly group: SessionsOverviewGroup
  readonly sort: SessionsOverviewSort
}

export interface SessionsOverviewGroupModel {
  readonly key: string
  readonly label?: string
  readonly rows: readonly SessionsProjectionRow[]
}

export const SESSIONS_OVERVIEW_PAGE_SIZE = 40

export interface SessionsOverviewPageModel {
  readonly pageIndex: number
  readonly pageCount: number
  readonly start: number
  readonly end: number
  readonly totalRows: number
  readonly groups: readonly SessionsOverviewGroupModel[]
  readonly rows: readonly SessionsProjectionRow[]
}

export type SessionsOverviewCardFactTone =
  'available' | 'actionable' | 'pending' | 'stale'

export interface SessionsOverviewCardFact {
  readonly label: string
  readonly value: string
  readonly tone: SessionsOverviewCardFactTone
}

export interface SessionsOverviewCardFactSummary {
  readonly label: 'Quiet state' | 'Limited facts'
  readonly value: string
}

export interface SessionsOverviewCardFacts {
  readonly facts: readonly SessionsOverviewCardFact[]
  readonly summaries: readonly SessionsOverviewCardFactSummary[]
}

export const DEFAULT_SESSIONS_OVERVIEW_POLICY: SessionsOverviewPolicy = {
  filter: 'all',
  group: 'project',
  sort: 'priority',
}

export function sessionsOverviewCardFacts(
  row: SessionsProjectionRow,
): SessionsOverviewCardFacts {
  const candidates = [
    fact(
      'Attention',
      row.attention,
      sentenceCase,
      (value) => value !== 'none',
      (value) => value === 'none',
    ),
    fact(
      'Working',
      row.working,
      (value) => (value ? 'Working' : 'Not working'),
      Boolean,
      (value) => !value,
    ),
    fact(
      'Provider turn',
      row.turn,
      (value) => sentenceCase(value.state),
      (value) =>
        value.state === 'waiting-for-user' || value.state === 'waiting-for-approval',
      (value) => value.state === 'idle',
    ),
    fact('Model', row.model, (value) => value.displayName ?? value.id),
    fact('Context', row.context, contextLabel),
    fact('Telemetry', row.telemetryFreshness, () => 'Available'),
    usageFact(row),
  ]
  const facts: SessionsOverviewCardFact[] = [
    {
      label: 'Lifecycle',
      value: `${sentenceCase(row.lifecycle)}${
        row.lifecycleReason ? ` · ${sentenceCase(row.lifecycleReason)}` : ''
      }`,
      tone:
        row.lifecycle === 'unavailable' || row.lifecycle === 'stopped'
          ? 'actionable'
          : 'available',
    },
    {
      label: 'Host',
      value: `${row.host.label} · ${sentenceCase(row.connectionState)}`,
      tone: row.connectionState === 'connected' ? 'available' : 'actionable',
    },
    ...candidates
      .filter((candidate) => candidate.compact === false)
      .map(({ compact: _compact, ...candidate }) => candidate),
  ]
  const grouped = new Map<string, string[]>()
  for (const candidate of candidates) {
    if (candidate.compact !== 'limited') continue
    const labels = grouped.get(candidate.value)
    if (labels) labels.push(candidate.label)
    else grouped.set(candidate.value, [candidate.label])
  }
  const quiet = candidates.filter((candidate) => candidate.compact === 'quiet')
  return {
    facts,
    summaries: [
      ...(quiet.length > 0
        ? [
            {
              label: 'Quiet state' as const,
              value: quiet
                .map((candidate) => `${candidate.label} — ${candidate.value}`)
                .join('; '),
            },
          ]
        : []),
      ...[...grouped].map(([value, labels]) => ({
        label: 'Limited facts' as const,
        value: `${listLabel(labels)} — ${value}`,
      })),
    ],
  }
}

interface CandidateFact extends SessionsOverviewCardFact {
  readonly compact: false | 'quiet' | 'limited'
}

function fact<T>(
  label: string,
  projected: SessionsFact<T>,
  available: (value: T) => string,
  actionable: (value: T) => boolean = () => false,
  quiet: (value: T) => boolean = () => false,
): CandidateFact {
  switch (projected.status) {
    case 'available':
      return {
        label,
        value: available(projected.value),
        tone: actionable(projected.value) ? 'actionable' : 'available',
        compact: quiet(projected.value) ? 'quiet' : false,
      }
    case 'stale':
      return {
        label,
        value: `Stale · ${available(projected.value)}`,
        tone: 'stale',
        compact: false,
      }
    case 'pending':
      return { label, value: 'Pending', tone: 'pending', compact: false }
    case 'unavailable':
      return {
        label,
        value: `Unavailable · ${sentenceCase(projected.reason)}`,
        tone: 'available',
        compact: 'limited',
      }
    case 'unsupported':
      return { label, value: 'Unsupported', tone: 'available', compact: 'limited' }
  }
}

function usageFact(row: SessionsProjectionRow): CandidateFact {
  const usage = row.usage
  const compact =
    usage.status === 'unavailable' || usage.status === 'unsupported' ? 'limited' : false
  const value =
    usage.status === 'unavailable'
      ? `Unavailable · ${sentenceCase(usage.reason)}`
      : usage.status === 'stale'
        ? `Stale · ${sentenceCase(usage.reason)}`
        : usage.status === 'reset'
          ? `Reset · ${sentenceCase(usage.reason)}`
          : sentenceCase(usage.status)
  return {
    label: 'Usage capability',
    value,
    tone:
      usage.status === 'pending' || usage.status === 'reset'
        ? 'pending'
        : usage.status === 'stale'
          ? 'stale'
          : 'available',
    compact,
  }
}

function contextLabel(value: {
  readonly usedTokens: number
  readonly windowTokens?: number
  readonly usedPercent?: number
}): string {
  if (value.usedPercent !== undefined) return `${value.usedPercent}% used`
  if (value.windowTokens !== undefined) {
    return `${value.usedTokens.toLocaleString()} of ${value.windowTokens.toLocaleString()} tokens`
  }
  return `${value.usedTokens.toLocaleString()} tokens used`
}

function sentenceCase(value: string): string {
  const spaced = value.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function listLabel(labels: readonly string[]): string {
  if (labels.length < 2) return labels[0] ?? ''
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
}

export function sessionsOverviewGroups(
  rows: readonly SessionsProjectionRow[],
  policy: SessionsOverviewPolicy,
): readonly SessionsOverviewGroupModel[] {
  const ordered = rows
    .filter((row) => sessionsOverviewMatchesFilter(row, policy.filter))
    .sort(sorter(policy.sort))
  if (policy.group === 'none') return [{ key: 'all', rows: ordered }]
  const groups = new Map<string, SessionsOverviewGroupModel>()
  for (const row of ordered) {
    const key =
      policy.group === 'project'
        ? `project:${row.project.id}`
        : `workspace:${row.workspace.id}`
    const current = groups.get(key)
    if (current) {
      groups.set(key, { ...current, rows: [...current.rows, row] })
      continue
    }
    groups.set(key, {
      key,
      label:
        policy.group === 'project'
          ? row.project.name
          : `${row.project.name} / ${row.workspace.name}`,
      rows: [row],
    })
  }
  return [...groups.values()]
}

export function sessionsOverviewRows(
  groups: readonly SessionsOverviewGroupModel[],
): readonly SessionsProjectionRow[] {
  return groups.flatMap((group) => group.rows)
}

export function sessionsOverviewPage(
  groups: readonly SessionsOverviewGroupModel[],
  requestedPage: number,
): SessionsOverviewPageModel {
  const allRows = sessionsOverviewRows(groups)
  const pageCount = Math.max(1, Math.ceil(allRows.length / SESSIONS_OVERVIEW_PAGE_SIZE))
  const pageIndex = Math.min(Math.max(requestedPage, 0), pageCount - 1)
  const start = pageIndex * SESSIONS_OVERVIEW_PAGE_SIZE
  const end = Math.min(start + SESSIONS_OVERVIEW_PAGE_SIZE, allRows.length)
  const visibleHandles = new Set(allRows.slice(start, end).map((row) => row.handle))
  const visibleGroups = groups.flatMap((group) => {
    const rows = group.rows.filter((row) => visibleHandles.has(row.handle))
    return rows.length > 0 ? [{ ...group, rows }] : []
  })
  return {
    pageIndex,
    pageCount,
    start,
    end,
    totalRows: allRows.length,
    groups: visibleGroups,
    rows: allRows.slice(start, end),
  }
}

export function sessionsOverviewFocusFallback(
  previous: readonly SessionsTerminalHandle[],
  next: readonly SessionsTerminalHandle[],
  selected: SessionsTerminalHandle | undefined,
): SessionsTerminalHandle | undefined {
  if (selected && next.includes(selected)) return selected
  if (next.length === 0) return undefined
  const previousIndex = selected ? previous.indexOf(selected) : -1
  return next[Math.min(Math.max(previousIndex, 0), next.length - 1)]
}

export function sessionsOverviewPolicyLabel(policy: SessionsOverviewPolicy): string {
  return `${filterLabel(policy.filter)} · Grouped by ${groupLabel(policy.group)} · Sorted by ${sortLabel(policy.sort)}`
}

export function filterLabel(filter: SessionsOverviewFilter): string {
  switch (filter) {
    case 'all':
      return 'All sessions'
    case 'harnesses':
      return 'Harnesses'
    case 'shells':
      return 'Shells'
    case 'attention':
      return 'Needs attention'
    case 'working':
      return 'Working'
  }
}

function groupLabel(group: SessionsOverviewGroup): string {
  switch (group) {
    case 'project':
      return 'project'
    case 'workspace':
      return 'workspace'
    case 'none':
      return 'none'
  }
}

function sortLabel(sort: SessionsOverviewSort): string {
  switch (sort) {
    case 'priority':
      return 'attention and activity'
    case 'title':
      return 'title'
    case 'project':
      return 'project and workspace'
  }
}

export function sessionsOverviewMatchesFilter(
  row: SessionsProjectionRow,
  filter: SessionsOverviewFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'harnesses':
      return row.provider.kind === 'agent'
    case 'shells':
      return row.provider.kind === 'shell'
    case 'attention':
      return row.attention.status === 'available' && row.attention.value !== 'none'
    case 'working':
      return row.working.status === 'available' && row.working.value
  }
}

function sorter(
  sort: SessionsOverviewSort,
): (left: SessionsProjectionRow, right: SessionsProjectionRow) => number {
  return (left, right) => {
    const policyOrder =
      sort === 'priority'
        ? sessionPriority(left) - sessionPriority(right)
        : sort === 'project'
          ? compareProject(left, right)
          : compareText(left.title, right.title)
    return (
      policyOrder ||
      compareProject(left, right) ||
      compareText(left.title, right.title) ||
      String(left.handle).localeCompare(String(right.handle))
    )
  }
}

function sessionPriority(row: SessionsProjectionRow): number {
  if (row.attention.status === 'available' && row.attention.value !== 'none') return 0
  if (row.working.status === 'available' && row.working.value) return 1
  return 2
}

function compareProject(
  left: SessionsProjectionRow,
  right: SessionsProjectionRow,
): number {
  return (
    compareText(left.project.name, right.project.name) ||
    compareText(left.workspace.name, right.workspace.name)
  )
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
}
