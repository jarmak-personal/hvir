import type { ReactElement } from 'react'

import type { SessionsProjectionRow } from '../../../shared'
import { ProviderContextMeter } from '../harness/ProviderContextMeter'
import {
  sessionsOverviewCardFacts,
  sessionsOverviewCardTitle,
  type SessionsOverviewGroup,
  type SessionsOverviewCardFact,
} from './sessions-overview-model'

export function SessionsOverviewCard({
  row,
  group,
  opening,
  onOpen,
  onInteract,
}: {
  readonly row: SessionsProjectionRow
  readonly group: SessionsOverviewGroup
  readonly opening: boolean
  readonly onOpen?: () => void
  readonly onInteract?: () => void
}): ReactElement {
  const presentation = sessionsOverviewCardFacts(row)
  const title = sessionsOverviewCardTitle(row, group)
  return (
    <>
      <header>
        <div className="session-card-identity">
          <span className={`session-kind ${row.provider.kind}`}>
            {row.provider.kind === 'agent'
              ? 'Agent'
              : row.provider.kind === 'shell'
                ? 'Shell'
                : 'Terminal'}
          </span>
          <h3>{title}</h3>
        </div>
        <div className="session-card-actions">
          {onInteract ? (
            <button type="button" onClick={onInteract}>
              Interact
            </button>
          ) : null}
          {onOpen ? (
            <button type="button" disabled={opening} onClick={onOpen}>
              {opening ? 'Opening…' : 'Open'}
            </button>
          ) : null}
        </div>
      </header>
      {row.context.status === 'available' || row.context.status === 'stale' ? (
        <ProviderContextMeter
          contextFacet={row.context}
          pressurePolicy={row.provider.contextPressure}
        />
      ) : null}
      <dl className="session-facts">
        {presentation.facts.map((fact) => (
          <Fact key={fact.label} fact={fact} />
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
