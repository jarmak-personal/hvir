import type { ReactElement, RefObject } from 'react'

import {
  filterLabel,
  sessionsOverviewPolicyLabel,
  type SessionsOverviewFilter,
  type SessionsOverviewGroup,
  type SessionsOverviewPolicy,
  type SessionsOverviewSort,
} from './sessions-overview-model'

export function SessionsCollectionToolbar({
  policy,
  collectionControl,
  onFilter,
  onGroup,
  onSort,
}: {
  readonly policy: SessionsOverviewPolicy
  readonly collectionControl: RefObject<HTMLButtonElement | null>
  readonly onFilter: (filter: SessionsOverviewFilter) => void
  readonly onGroup: (group: SessionsOverviewGroup) => void
  readonly onSort: (sort: SessionsOverviewSort) => void
}): ReactElement {
  return (
    <>
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
        <label>
          Group
          <select
            value={policy.group}
            onChange={(event) =>
              onGroup(event.currentTarget.value as SessionsOverviewGroup)
            }
          >
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
            <option value="project">Workspace</option>
          </select>
        </label>
      </section>
      <p className="sessions-policy" aria-live="polite">
        {sessionsOverviewPolicyLabel(policy)}
      </p>
    </>
  )
}
