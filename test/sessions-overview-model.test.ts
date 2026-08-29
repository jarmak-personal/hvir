import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SESSIONS_OVERVIEW_POLICY,
  SESSIONS_OVERVIEW_PAGE_SIZE,
  sessionsOverviewCardFacts,
  sessionsOverviewCardTitle,
  sessionsOverviewFocusFallback,
  sessionsOverviewGroups,
  sessionsOverviewPage,
  sessionsOverviewRows,
} from '../src/renderer/src/sessions/sessions-overview-model'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
} from '../src/shared'

describe('Sessions overview policy', () => {
  it('keeps quiet membership while separating harnesses, shells, attention, and Working', () => {
    const rows = [
      row('quiet-agent', { title: 'Quiet agent' }),
      row('shell', { kind: 'shell' }),
      row('attention', { attention: 'ready' }),
      row('working', { working: true }),
      row('unknown', { kind: 'unknown' }),
    ]

    expect(filtered(rows, 'all')).toEqual([
      'attention',
      'working',
      'quiet-agent',
      'shell',
      'unknown',
    ])
    expect(filtered(rows, 'harnesses')).toEqual(['attention', 'working', 'quiet-agent'])
    expect(filtered(rows, 'shells')).toEqual(['shell'])
    expect(filtered(rows, 'attention')).toEqual(['attention'])
    expect(filtered(rows, 'working')).toEqual(['working'])
  })

  it('groups without losing deterministic priority and disclosure order', () => {
    const groups = sessionsOverviewGroups(
      [
        row('b', { project: 'Project B', workspace: 'main' }),
        row('a-working', { project: 'Project A', workspace: 'feature', working: true }),
        row('a-ready', { project: 'Project A', workspace: 'main', attention: 'bell' }),
      ],
      { ...DEFAULT_SESSIONS_OVERVIEW_POLICY, group: 'project' },
    )

    expect(groups.map((group) => group.label)).toEqual(['Project A', 'Project B'])
    expect(
      groups.flatMap((group) => group.rows.map((candidate) => candidate.handle)),
    ).toEqual(['a-ready', 'a-working', 'b'])
  })

  it('places live sessions ahead of retained sessions when neither needs attention', () => {
    const groups = sessionsOverviewGroups(
      [
        row('retained-a', { project: 'Archwitness' }),
        row('live', { project: 'hvir', lifecycle: 'live' }),
        row('retained-b', { project: 'Scrabalatro' }),
      ],
      DEFAULT_SESSIONS_OVERVIEW_POLICY,
    )

    expect(sessionsOverviewRows(groups).map((candidate) => candidate.handle)).toEqual([
      'live',
      'retained-a',
      'retained-b',
    ])
  })

  it('preserves an opaque selection across reorder and chooses a deterministic neighbor on removal', () => {
    const first = ['a', 'b', 'c'].map(asSessionsTerminalHandle)
    const reordered = ['c', 'b', 'a'].map(asSessionsTerminalHandle)
    expect(sessionsOverviewFocusFallback(first, reordered, first[1])).toBe(first[1])
    expect(
      sessionsOverviewFocusFallback(
        first,
        ['a', 'c'].map(asSessionsTerminalHandle),
        first[1],
      ),
    ).toBe('c')
    expect(sessionsOverviewFocusFallback(first, [], first[1])).toBeUndefined()
  })

  it('keeps the projection capacity bound deterministic without creating another limit', () => {
    const rows = Array.from({ length: MAX_SESSIONS_PROJECTION_ROWS }, (_, index) =>
      row(`capacity-${index}`, {
        project: `Project ${index % 20}`,
        workspace: `worktree-${index % 50}`,
        working: index % 7 === 0,
      }),
    )
    const ordered = sessionsOverviewRows(
      sessionsOverviewGroups(rows, DEFAULT_SESSIONS_OVERVIEW_POLICY),
    )

    expect(ordered).toHaveLength(MAX_SESSIONS_PROJECTION_ROWS)
    expect(new Set(ordered.map((candidate) => candidate.handle)).size).toBe(
      MAX_SESSIONS_PROJECTION_ROWS,
    )
    const groups = sessionsOverviewGroups(rows, DEFAULT_SESSIONS_OVERVIEW_POLICY)
    const first = sessionsOverviewPage(groups, 0)
    const last = sessionsOverviewPage(groups, Number.MAX_SAFE_INTEGER)
    expect(first.rows).toHaveLength(SESSIONS_OVERVIEW_PAGE_SIZE)
    expect(last.pageIndex).toBe(last.pageCount - 1)
    expect(last.rows.length).toBeLessThanOrEqual(SESSIONS_OVERVIEW_PAGE_SIZE)
    expect(first.groups.flatMap((group) => group.rows)).toEqual(first.rows)
  })

  it('omits unknown and pending facts while retaining useful stale conditions', () => {
    const fixture = row('retained')
    const presentation = sessionsOverviewCardFacts({
      ...fixture,
      attention: { status: 'unavailable', reason: 'not-materialized' },
      working: { status: 'unavailable', reason: 'not-materialized' },
      model: {
        status: 'stale',
        value: { id: 'model-safe' },
        observedAt: 10,
        reason: 'source-stale',
      },
      context: { status: 'pending', reason: 'telemetry-pending' },
      turn: { status: 'unsupported' },
      telemetryFreshness: {
        status: 'stale',
        value: { staleAfterMs: 30_000 },
        observedAt: 10,
        reason: 'source-stale',
      },
      usage: { status: 'unavailable', reason: 'not-live' },
    })

    expect(presentation.facts).toEqual([
      { label: 'Model', value: 'Stale · model-safe', tone: 'stale' },
    ])
  })

  it('omits neutral activity without hiding non-neutral action', () => {
    const quiet = sessionsOverviewCardFacts(row('quiet'))
    const attention = sessionsOverviewCardFacts(
      row('attention', { attention: 'bell', working: true }),
    )

    expect(quiet.facts).toEqual([])
    expect(attention.facts).toEqual(
      expect.arrayContaining([
        { label: 'Attention', value: 'Bell', tone: 'actionable' },
        { label: 'Working', value: 'Working', tone: 'actionable' },
      ]),
    )
  })

  it('prefers the renderer-safe projected title while preserving group context', () => {
    const fixture = row('safe-handle', {
      title: 'Review release notes',
      project: 'Project One',
      workspace: 'feature',
    })

    expect(sessionsOverviewCardTitle(fixture, 'workspace')).toBe('Review release notes')
    expect(sessionsOverviewCardTitle(fixture, 'project')).toBe(
      'Review release notes · feature',
    )
    expect(sessionsOverviewCardTitle(fixture, 'none')).toBe(
      'Review release notes · Project One / feature',
    )
  })

  it('uses a generic provider label when the projected title is unavailable', () => {
    expect(sessionsOverviewCardTitle(row('agent', { title: '' }), 'workspace')).toBe(
      'Codex session',
    )
    expect(
      sessionsOverviewCardTitle(row('shell', { title: '', kind: 'shell' }), 'workspace'),
    ).toBe('Shell terminal')
  })
})

function filtered(
  rows: readonly SessionsProjectionRow[],
  filter: 'all' | 'harnesses' | 'shells' | 'attention' | 'working',
) {
  return sessionsOverviewRows(
    sessionsOverviewGroups(rows, { ...DEFAULT_SESSIONS_OVERVIEW_POLICY, filter }),
  ).map((candidate) => candidate.handle)
}

function row(
  id: string,
  options: {
    readonly title?: string
    readonly kind?: 'agent' | 'shell' | 'unknown'
    readonly project?: string
    readonly workspace?: string
    readonly attention?: 'none' | 'ready' | 'bell'
    readonly working?: boolean
    readonly lifecycle?: SessionsProjectionRow['lifecycle']
  } = {},
): SessionsProjectionRow {
  const unavailable = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle(id),
    project: {
      id: asSessionsProjectHandle(`project-${options.project ?? 'Project A'}`),
      name: options.project ?? 'Project A',
    },
    workspace: {
      id: asSessionsWorkspaceHandle(`workspace-${options.workspace ?? 'main'}`),
      name: options.workspace ?? 'main',
      main: (options.workspace ?? 'main') === 'main',
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId(
        options.kind === 'shell'
          ? 'plain-shell'
          : options.kind === 'unknown'
            ? 'missing-provider'
            : 'codex',
      ),
      name:
        options.kind === 'shell'
          ? 'Shell'
          : options.kind === 'unknown'
            ? 'missing-provider'
            : 'Codex',
      kind: options.kind ?? 'agent',
    },
    profile: {
      status: 'available',
      value: { id: asHarnessProfileId('fixture-profile') },
    },
    title: options.title ?? id,
    lifecycle: options.lifecycle ?? 'retained',
    connectionState: 'connected',
    attention: { status: 'available', value: options.attention ?? 'none' },
    working: { status: 'available', value: options.working ?? false },
    model: unavailable,
    context: unavailable,
    turn: unavailable,
    telemetryFreshness: unavailable,
    usage: { status: 'unsupported' },
  }
}
