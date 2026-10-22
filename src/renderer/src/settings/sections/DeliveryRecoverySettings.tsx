import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  DeliveryRecoveryEntry,
  DeliveryRecoveryReply,
} from '../../../../shared/extensions/managed-delivery'
import type { ExtensionPlatformState } from '../../../../shared/extensions/workbench'

const deliveryOutcome = (outcome: string): string =>
  outcome === 'completed-with-retained-objects'
    ? 'Delivery completed · saved files remain'
    : outcome === 'conflicted-with-retained-objects'
      ? 'Delivery conflict · saved files remain'
      : outcome === 'completion-unproven'
        ? 'Completion unknown'
        : outcome

/** Exact recovery remains reachable after package demand and installation identity end. */
export function DeliveryRecoverySettings({
  active = true,
  platformState,
  onAttention,
}: {
  readonly active?: boolean
  readonly platformState?: ExtensionPlatformState
  readonly onAttention?: (message: string) => void
}): ReactElement {
  const [entries, setEntries] = useState<readonly DeliveryRecoveryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [observation, setObservation] = useState(0)
  const [message, setMessage] = useState('')
  const [observationError, setObservationError] = useState('')
  const [operationFailed, setOperationFailed] = useState(false)
  const [decision, setDecision] = useState<DeliveryRecoveryReply>()
  const inspection = useRef(0)
  useEffect(() => {
    if (!active) {
      inspection.current++
      setDecision(undefined)
    }
  }, [active])
  useEffect(() => {
    onAttention?.(
      observationError || operationFailed
        ? 'Recovery needs attention'
        : entries.length
          ? `${entries.length} to inspect`
          : '',
    )
  }, [entries.length, observationError, operationFailed, onAttention])
  const revision = useRef(0),
    mounted = useRef(false)
  const refresh = useCallback(async (current: () => boolean): Promise<void> => {
    try {
      const value = await window.hvir.invoke('extensions:delivery-recovery', undefined)
      if (!Array.isArray(value))
        throw new Error(
          'Complete retained delivery records are unavailable; files remain in place',
        )
      if (current()) {
        setEntries(value)
        setObservationError('')
      }
    } catch (reason) {
      if (current())
        setObservationError(
          reason instanceof Error ? reason.message : 'Delivery recovery unavailable',
        )
    }
  }, [])
  const run = async (task: (current: () => boolean) => Promise<void>): Promise<void> => {
    const request = ++revision.current,
      current = () => mounted.current && revision.current === request
    setBusy(true)
    setMessage('')
    setOperationFailed(false)
    try {
      await task(current)
    } catch (reason) {
      if (current()) {
        setOperationFailed(true)
        setMessage(
          reason instanceof Error
            ? reason.message
            : 'Delivery recovery failed; files remain in place',
        )
      }
    } finally {
      if (current()) {
        setBusy(false)
        setObservation((value) => value + 1)
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    const revisions = revision
    return () => {
      mounted.current = false
      revisions.current++
    }
  }, [])
  useEffect(() => {
    if (busy) return
    let observing = true
    const request = ++revision.current
    void refresh(() => observing && mounted.current && revision.current === request)
    return () => {
      observing = false
    }
  }, [platformState, busy, observation, refresh])
  return (
    <details
      className="extension-delivery-recovery"
      aria-label="Retained extension deliveries"
      open={entries.length > 0 || !!message || !!observationError || !!decision}
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
        onClick={() => setObservation((value) => value + 1)}
      >
        Refresh retained deliveries
      </button>
      {entries.map((entry) => (
        <article key={entry.id}>
          <p>
            <strong>{deliveryOutcome(entry.outcome)}</strong> · Extension{' '}
            {entry.installation}
          </p>
          <p>
            Target: {entry.target.hostId}: {entry.target.path}
          </p>
          <details>
            <summary>Delivery details</summary>
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
                const inspecting = ++inspection.current
                const result = await window.hvir.invoke('extensions:delivery-resolve', {
                  kind: 'inspect',
                  id: entry.id,
                })
                if (!result.token || !result.objects || !result.completion)
                  throw new Error('Current file details are unavailable; inspect again')
                if (current() && inspection.current === inspecting) setDecision(result)
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
              })
            }
          >
            Keep these files and end delivery tracking
          </button>
        </fieldset>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {observationError ? <p role="status">{observationError}</p> : null}
    </details>
  )
}
