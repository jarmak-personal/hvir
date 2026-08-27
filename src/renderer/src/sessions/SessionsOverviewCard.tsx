import type { ReactElement } from 'react'

import type { SessionsFact, SessionsProjectionRow } from '../../../shared'
import {
  sessionsOverviewCardFacts,
  type SessionsOverviewCardFact,
} from './sessions-overview-model'

export function SessionsOverviewCard({
  row,
  opening,
  onOpen,
  onInteract,
}: {
  readonly row: SessionsProjectionRow
  readonly opening: boolean
  readonly onOpen: () => void
  readonly onInteract?: () => void
}): ReactElement {
  const presentation = sessionsOverviewCardFacts(row)
  return (
    <>
      <header>
        <div>
          <span className={`session-kind ${row.provider.kind}`}>
            {row.provider.kind === 'agent'
              ? 'Agent harness'
              : row.provider.kind === 'shell'
                ? 'Non-agent shell'
                : 'Provider capability unavailable'}
          </span>
          <h3>{row.title}</h3>
        </div>
        <div className="session-card-actions">
          {onInteract ? (
            <button type="button" onClick={onInteract}>
              Interact
            </button>
          ) : null}
          <button type="button" disabled={opening} onClick={onOpen}>
            {opening ? 'Opening…' : 'Open'}
          </button>
        </div>
      </header>
      <p className="session-location">
        {row.project.name} <span aria-hidden="true">/</span> {row.workspace.name}
        {row.workspace.main ? <small>project root</small> : null}
      </p>
      <p className="session-provider">
        {row.provider.name} · {factLabel(row.profile, (value) => String(value.id))}
      </p>
      <dl className="session-facts">
        {presentation.facts.map((fact) => (
          <Fact key={fact.label} fact={fact} />
        ))}
        {presentation.summaries.map((summary) => (
          <div className="session-fact-summary" key={`${summary.label}:${summary.value}`}>
            <dt>{summary.label}</dt>
            <dd>{summary.value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

function Fact({ fact }: { readonly fact: SessionsOverviewCardFact }): ReactElement {
  return (
    <div className={`session-fact ${fact.tone}`}>
      <dt>{fact.label}</dt>
      <dd>{fact.value}</dd>
    </div>
  )
}

function factLabel<T>(fact: SessionsFact<T>, available: (value: T) => string): string {
  switch (fact.status) {
    case 'available':
      return available(fact.value)
    case 'stale':
      return `Stale · ${available(fact.value)}`
    case 'pending':
      return 'Pending'
    case 'unavailable':
      return `Unavailable · ${reasonLabel(fact.reason)}`
    case 'unsupported':
      return 'Unsupported'
  }
}

function reasonLabel(reason: string): string {
  const spaced = reason.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
