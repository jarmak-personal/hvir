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

export interface SessionsOverviewCardFacts {
  readonly facts: readonly SessionsOverviewCardFact[]
}

export const DEFAULT_SESSIONS_OVERVIEW_POLICY: SessionsOverviewPolicy = {
  filter: 'all',
  group: 'workspace',
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
      (value) => value !== 'none',
    ),
    fact('Working', row.working, () => 'Working', Boolean, Boolean),
    fact(
      'Provider turn',
      row.turn,
      (value) => sentenceCase(value.state),
      (value) =>
        value.state === 'waiting-for-user' || value.state === 'waiting-for-approval',
      (value) => value.state !== 'idle',
    ),
    fact('Model', row.model, (value) => value.displayName ?? value.id),
  ].filter((candidate): candidate is SessionsOverviewCardFact => candidate !== undefined)
  return { facts: candidates }
}

function fact<T>(
  label: string,
  projected: SessionsFact<T>,
  available: (value: T) => string,
  actionable: (value: T) => boolean = () => false,
  visible: (value: T) => boolean = () => true,
): SessionsOverviewCardFact | undefined {
  switch (projected.status) {
    case 'available': {
      if (!visible(projected.value)) return undefined
      return {
        label,
        value: available(projected.value),
        tone: actionable(projected.value) ? 'actionable' : 'available',
      }
    }
    case 'stale':
      return {
        label,
        value: `Stale · ${available(projected.value)}`,
        tone: 'stale',
      }
    case 'pending':
    case 'unavailable':
    case 'unsupported':
      return undefined
  }
}

function sentenceCase(value: string): string {
  const spaced = value.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
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

export function sessionsOverviewProjectRows(
  rows: readonly SessionsProjectionRow[],
  project: SessionsProjectionRow['project']['id'] | undefined,
): readonly SessionsProjectionRow[] {
  return project ? rows.filter((row) => row.project.id === project) : []
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
