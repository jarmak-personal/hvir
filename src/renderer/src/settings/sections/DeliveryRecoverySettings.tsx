import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  DeliveryRecoveryEntry,
  DeliveryRecoveryReply,
} from '../../../../shared/extensions/managed-delivery'

/** Exact recovery remains reachable after package demand and installation identity end. */
export function DeliveryRecoverySettings(): ReactElement {
  const [entries, setEntries] = useState<readonly DeliveryRecoveryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [decision, setDecision] = useState<DeliveryRecoveryReply>()
  const revision = useRef(0),
    mounted = useRef(false)
  const refresh = async (current: () => boolean): Promise<void> => {
    const value = await window.hvir.invoke('extensions:delivery-recovery', undefined)
    if (!Array.isArray(value))
      throw new Error(
        'Complete retained delivery records are unavailable; files remain in place',
      )
    if (current()) setEntries(value)
  }
  const run = async (task: (current: () => boolean) => Promise<void>): Promise<void> => {
    const request = ++revision.current,
      current = () => mounted.current && revision.current === request
    setBusy(true)
    setMessage('')
    try {
      await task(current)
    } catch (reason) {
      if (current())
        setMessage(
          reason instanceof Error
            ? reason.message
            : 'Delivery recovery failed; files remain in place',
        )
    } finally {
      if (current()) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    const revisions = revision
    const request = ++revisions.current
    void window.hvir
      .invoke('extensions:delivery-recovery', undefined)
      .then((value) => {
        if (!mounted.current || revision.current !== request) return
        if (!Array.isArray(value))
          throw new Error(
            'Complete retained delivery records are unavailable; files remain in place',
          )
        setEntries(value)
      })
      .catch((reason) => {
        if (mounted.current && revision.current === request)
          setMessage(
            reason instanceof Error ? reason.message : 'Delivery recovery unavailable',
          )
      })
    return () => {
      mounted.current = false
      revisions.current++
    }
  }, [])
  return (
    <details
      className="extension-delivery-recovery"
      aria-label="Retained extension deliveries"
      open={entries.length > 0 || !!message || !!decision}
    >
      <summary>
        Delivery recovery{entries.length ? ` · ${entries.length} to inspect` : ''}
      </summary>
      <p>
        Removing an extension keeps these saved remote files. Inspect them before cleanup
        or ending tracking; an unknown completion remains unknown.
      </p>
      <button
        type="button"
        className="hvir-button"
        disabled={busy}
        onClick={() => void run(refresh)}
      >
        Refresh retained deliveries
      </button>
      {entries.map((entry) => (
        <article key={entry.id}>
          <p>
            Delivery needs attention. Inspect the saved files before choosing what to
            keep.
          </p>
          <p>
            Target: {entry.target.hostId}: {entry.target.path}
          </p>
          <details>
            <summary>Delivery details</summary>
            <p>
              {entry.outcome} · {entry.installation}
            </p>
            <p>
              Staging: {entry.staging.hostId}: {entry.staging.path}
            </p>
            <p>
              Preserved: {entry.preserved.hostId}: {entry.preserved.path}
            </p>
          </details>
          <button
            type="button"
            className="hvir-button"
            disabled={busy}
            onClick={() =>
              void run(async (current) => {
                const result = await window.hvir.invoke('extensions:delivery-resolve', {
                  kind: 'inspect',
                  id: entry.id,
                })
                if (!result.token || !result.objects || !result.completion)
                  throw new Error('Current file details are unavailable; inspect again')
                if (current()) setDecision(result)
              })
            }
          >
            Inspect retained files
          </button>
          <button
            type="button"
            className="hvir-button"
            disabled={busy}
            onClick={() =>
              void run(async (current) => {
                const result = await window.hvir.invoke('extensions:delivery-resolve', {
                  kind: 'reconcile',
                  id: entry.id,
                })
                if (!current()) return
                setMessage(
                  `Reconciliation: ${result.outcome}. No publication was replayed.`,
                )
                setDecision(undefined)
                await refresh(current)
              })
            }
          >
            Check delivery status
          </button>
          <p>
            Cleanup removes only verified saved staging and preserved old copies. Target
            files stay in place; inspect Delivery details for the exact paths.
          </p>
          <button
            type="button"
            className="hvir-button"
            disabled={busy}
            onClick={() =>
              void run(async (current) => {
                const result = await window.hvir.invoke('extensions:delivery-resolve', {
                  kind: 'cleanup',
                  id: entry.id,
                })
                if (!current()) return
                setMessage(`Cleanup: ${result.outcome}. Target files stay in place.`)
                setDecision(undefined)
                await refresh(current)
              })
            }
          >
            Remove saved staging and old copies
          </button>
        </article>
      ))}
      {decision ? (
        <fieldset disabled={busy}>
          <legend>Keep files and end tracking?</legend>
          <p>
            Original completion: {decision.completion}. All listed files remain in place,
            including changed or unverifiable objects. hvir will no longer update, remove
            or clean this delivery. This does not claim successful cleanup or completion.
          </p>
          {decision.objects?.map((object) => (
            <p key={object.path.path}>
              {object.state} · {object.path.hostId}: {object.path.path} · recorded
              identity {object.recordedIdentity ?? 'unknown'} · observed identity{' '}
              {object.identity ?? 'unknown'}
            </p>
          ))}
          <button
            type="button"
            className="hvir-button"
            onClick={() => setDecision(undefined)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="hvir-button"
            onClick={() =>
              void run(async (current) => {
                await window.hvir.invoke('extensions:delivery-resolve', {
                  kind: 'keep',
                  id: decision.token!,
                })
                if (!current()) return
                setDecision(undefined)
                setMessage(
                  'Files kept. Delivery tracking ended without cleanup or adoption.',
                )
                await refresh(current)
              })
            }
          >
            Keep these files and end delivery tracking
          </button>
        </fieldset>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </details>
  )
}
