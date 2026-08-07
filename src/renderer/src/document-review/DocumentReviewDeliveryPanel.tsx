import type { ReactElement } from 'react'

import type { DocumentReviewDeliveryInteraction } from './use-document-review-delivery'

export function DocumentReviewDeliveryPanel({
  delivery,
}: {
  readonly delivery: DocumentReviewDeliveryInteraction
}): ReactElement | null {
  if (!delivery.open) return null
  const selected = delivery.selectedDestination
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
              {destination.capability === 'send-now'
                ? 'Send now supported'
                : destination.capability === 'insert'
                  ? 'Insert supported'
                  : 'Copy only'}
            </option>
          ))}
        </select>
      </label>
      {!delivery.loading && delivery.destinations.length === 0 ? (
        <p className="document-review-guidance" role="status">
          No live terminals are available in this host-qualified workspace. You can still
          copy the exact preview.
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
      {selected?.attention === 'bell' ? (
        <p className="document-review-warning" role="alert">
          This terminal is requesting attention. Resolve its current prompt or state before
          inserting.
        </p>
      ) : null}
      {delivery.payload ? (
        <>
          <pre
            className="document-review-delivery-payload"
            aria-label="Exact review delivery preview"
          >
            {delivery.payload.body}
          </pre>
          <p className="document-review-delivery-size">
            Exact UTF-8 body · {delivery.payload.byteLength.toLocaleString()} bytes
          </p>
          <div className="document-review-delivery-actions">
            <button type="button" disabled={delivery.loading} onClick={delivery.copy}>
              {delivery.copied ? 'Copied' : 'Copy exact preview'}
            </button>
            <button
              type="button"
              disabled={
                delivery.loading ||
                delivery.inserted ||
                delivery.sent ||
                !delivery.prepared
              }
              title={
                delivery.prepared
                  ? 'Insert one atomic bracketed paste without submitting'
                  : selected?.capability === 'copy-only'
                    ? 'This provider is Copy-only'
                    : 'Choose an Insert-supported terminal'
              }
              onClick={delivery.insert}
            >
              {delivery.inserted ? 'Inserted' : 'Insert into composer'}
            </button>
            <button
              type="button"
              disabled={
                delivery.loading ||
                delivery.inserted ||
                delivery.sent ||
                delivery.prepared?.destination.capability !== 'send-now'
              }
              title={
                delivery.prepared?.destination.capability === 'send-now'
                  ? `Send this exact preview now to ${delivery.prepared.destination.title}`
                  : 'This provider/launch has no proven submission contract'
              }
              onClick={delivery.sendNow}
            >
              {delivery.sent ? 'Sent' : 'Send exact review now'}
            </button>
          </div>
        </>
      ) : null}
      {delivery.loading ? <p role="status">Preparing exact review…</p> : null}
      {delivery.error ? (
        <p className="document-review-error" role="alert">
          {delivery.error}
        </p>
      ) : null}
    </section>
  )
}
