import type { ReactElement } from 'react'

import type { SessionsFact, SessionsProjectionRow } from '../../../shared'

export function SessionsOverviewCard({
  row,
  opening,
  onOpen,
}: {
  readonly row: SessionsProjectionRow
  readonly opening: boolean
  readonly onOpen: () => void
}): ReactElement {
  return (
    <>
      <header>
        <div>
          <span className={`session-kind ${row.provider.kind}`}>
            {row.provider.kind === 'agent' ? 'Agent harness' : 'Non-agent shell'}
          </span>
          <h3>{row.title}</h3>
        </div>
        <button type="button" disabled={opening} onClick={onOpen}>
          {opening ? 'Opening…' : 'Open'}
        </button>
      </header>
      <p className="session-location">
        {row.project.name} <span aria-hidden="true">/</span> {row.workspace.name}
        {row.workspace.main ? <small>project root</small> : null}
      </p>
      <p className="session-provider">
        {row.provider.name} · {factLabel(row.profile, (value) => String(value.id))}
      </p>
      <dl className="session-facts">
        <Fact label="Lifecycle" value={row.lifecycle} reason={row.lifecycleReason} />
        <Fact label="Host" value={`${row.host.label} · ${row.connectionState}`} />
        <Fact label="Attention" value={factLabel(row.attention, sentenceCase)} />
        <Fact
          label="Working"
          value={factLabel(row.working, (value) => (value ? 'Working' : 'Not working'))}
        />
        <Fact
          label="Provider turn"
          value={factLabel(row.turn, (value) => sentenceCase(value.state))}
        />
        <Fact
          label="Model"
          value={factLabel(row.model, (value) => value.displayName ?? value.id)}
        />
        <Fact label="Context" value={factLabel(row.context, contextLabel)} />
        <Fact
          label="Telemetry"
          value={factLabel(row.telemetryFreshness, () => 'Available')}
        />
        <Fact label="Usage capability" value={row.usage.status} />
      </dl>
    </>
  )
}

function Fact({
  label,
  value,
  reason,
}: {
  readonly label: string
  readonly value: string
  readonly reason?: string
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {sentenceCase(value)}
        {reason ? ` · ${reasonLabel(reason)}` : ''}
      </dd>
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

function reasonLabel(reason: string): string {
  return reason.replaceAll('-', ' ')
}
