import type { ReactElement } from 'react'

import type { DocumentReviewDeliveryInteraction } from './use-document-review-delivery'

export function DocumentReviewDeliveryPanel({
  delivery,
}: {
  readonly delivery: DocumentReviewDeliveryInteraction
}): ReactElement | null {
  if (!delivery.open) return null
  const selected = delivery.prepared?.destination
  return (
    <section className="document-review-delivery" aria-label="Review handoff preview">
      <header>
        <strong>Review handoff</strong>
        <button type="button" onClick={delivery.close}>
          Close preview
        </button>
      </header>
      <label>
        <span>Exact destination</span>
        <select
          aria-label="Review handoff destination"
          value={delivery.selectedTerminalId ?? ''}
          disabled={delivery.loading || delivery.destinations.length === 0}
          onChange={(event) => delivery.selectDestination(event.currentTarget.value)}
        >
          <option value="">Choose a live terminal…</option>
          {delivery.destinations.map((destination) => (
            <option key={destination.terminalId} value={destination.terminalId}>
              {destination.title} · {destination.providerName} ·{' '}
              {destination.capability === 'insert' ? 'Insert supported' : 'Copy only'}
            </option>
          ))}
        </select>
      </label>
      {!delivery.loading && delivery.destinations.length === 0 ? (
        <p className="document-review-guidance" role="status">
          No live terminals are available in this host-qualified workspace. Copy remains
          available after a live destination can be identified.
        </p>
      ) : null}
      {selected ? (
        <dl className="document-review-destination">
          <div>
            <dt>Terminal</dt>
            <dd>{selected.title}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{selected.providerName}</dd>
          </div>
          <div>
            <dt>Lifecycle</dt>
            <dd>
              {selected.lifecycle} · host {selected.connection}
            </dd>
          </div>
          <div>
            <dt>Attention</dt>
            <dd>{selected.attention ?? 'none'}</dd>
          </div>
        </dl>
      ) : null}
      {selected ? (
        <p className="document-review-warning" role="status">
          hvir cannot prove that this terminal is currently showing its composer. The
          selected destination stays fixed if focus, tabs, panes, or workspaces change.
        </p>
      ) : null}
      {delivery.prepared ? (
        <>
          <pre
            className="document-review-delivery-payload"
            aria-label="Exact review delivery preview"
          >
            {delivery.prepared.payload.body}
          </pre>
          <p className="document-review-delivery-size">
            Exact UTF-8 body · {delivery.prepared.payload.byteLength.toLocaleString()} bytes
          </p>
          <div className="document-review-delivery-actions">
            <button type="button" disabled={delivery.loading} onClick={delivery.copy}>
              Copy exact preview
            </button>
            <button
              type="button"
              disabled={
                delivery.loading ||
                delivery.inserted ||
                delivery.prepared.destination.capability !== 'insert'
              }
              title={
                delivery.prepared.destination.capability === 'insert'
                  ? 'Insert one atomic bracketed paste without submitting'
                  : 'This provider is Copy-only'
              }
              onClick={delivery.insert}
            >
              Insert into composer
            </button>
          </div>
          {delivery.prepared.destination.capability === 'copy-only' ? (
            <p className="document-review-guidance">
              This provider has no trusted atomic composer contract. It remains Copy-only.
            </p>
          ) : null}
        </>
      ) : null}
      {delivery.loading ? <p role="status">Preparing exact review…</p> : null}
      {delivery.error ? (
        <p className="document-review-error" role="alert">
          {delivery.error}
        </p>
      ) : null}
      {delivery.message ? <p role="status">{delivery.message}</p> : null}
    </section>
  )
}
