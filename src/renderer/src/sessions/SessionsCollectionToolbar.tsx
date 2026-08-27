import type { ReactElement, RefObject } from 'react'

import {
  filterLabel,
  sessionsOverviewPolicyLabel,
  type SessionsOverviewFilter,
  type SessionsOverviewGroup,
  type SessionsOverviewPolicy,
  type SessionsOverviewSort,
} from './sessions-overview-model'

export type SessionsLens = 'overview' | 'usage'

export function SessionsCollectionToolbar({
  lens,
  policy,
  collectionControl,
  onLens,
  onFilter,
  onGroup,
  onSort,
}: {
  readonly lens: SessionsLens
  readonly policy: SessionsOverviewPolicy
  readonly collectionControl: RefObject<HTMLButtonElement | null>
  readonly onLens: (lens: SessionsLens) => void
  readonly onFilter: (filter: SessionsOverviewFilter) => void
  readonly onGroup: (group: SessionsOverviewGroup) => void
  readonly onSort: (sort: SessionsOverviewSort) => void
}): ReactElement {
  return (
    <>
      <nav className="sessions-lenses" aria-label="Sessions views">
        {(['overview', 'usage'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-current={lens === value ? 'page' : undefined}
            onClick={() => onLens(value)}
          >
            {value === 'overview' ? 'Overview' : 'Usage'}
          </button>
        ))}
      </nav>
      <section className="sessions-controls" aria-label="Session collection controls">
        <fieldset>
          <legend>Filter</legend>
          {(['all', 'harnesses', 'shells', 'attention', 'working'] as const).map(
            (filter) => (
              <button
                key={filter}
                ref={filter === 'all' ? collectionControl : undefined}
                type="button"
                aria-pressed={policy.filter === filter}
                onClick={() => onFilter(filter)}
              >
                {filterLabel(filter)}
              </button>
            ),
          )}
        </fieldset>
        {lens === 'overview' ? (
          <>
            <label>
              Group
              <select
                value={policy.group}
                onChange={(event) =>
                  onGroup(event.currentTarget.value as SessionsOverviewGroup)
                }
              >
                <option value="project">Project</option>
                <option value="workspace">Workspace</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>
              Sort
              <select
                value={policy.sort}
                onChange={(event) =>
                  onSort(event.currentTarget.value as SessionsOverviewSort)
                }
              >
                <option value="priority">Attention and activity</option>
                <option value="title">Title</option>
                <option value="project">Project and workspace</option>
              </select>
            </label>
          </>
        ) : null}
      </section>
      <p className="sessions-policy" aria-live="polite">
        {lens === 'overview'
          ? sessionsOverviewPolicyLabel(policy)
          : `${filterLabel(policy.filter)} · Ranked by provider-neutral token usage`}
      </p>
    </>
  )
}
