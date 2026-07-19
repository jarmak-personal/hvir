import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HarnessProfile, HarnessProviderDescriptor } from '../../../shared'

export function HarnessRiskDialog({
  profile,
  provider,
  onCancel,
  onLaunch,
}: {
  readonly profile: HarnessProfile
  readonly provider?: HarnessProviderDescriptor
  readonly onCancel: () => void
  readonly onLaunch: () => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  onCancelRef.current = onCancel

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (busyRef.current) return
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled)',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog harness-risk-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-risk-title"
        tabIndex={-1}
      >
        <h2 id="harness-risk-title">
          {profile.risk === 'elevated'
            ? 'Elevated harness profile'
            : 'Unclassified harness profile'}
        </h2>
        <p>
          <strong>
            {provider?.displayName ?? profile.providerId} · {profile.displayName}
          </strong>
        </p>
        <p>
          {profile.risk === 'elevated'
            ? 'This profile includes a provider-known permission or sandbox bypass.'
            : 'hvir cannot confidently classify every executable, argument, or environment setting in this profile.'}
        </p>
        <small>
          Acknowledgment applies only to launch revision {profile.launchRevision}. Risk
          classification is best-effort, not a security boundary.
        </small>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              busyRef.current = true
              setBusy(true)
              setError(undefined)
              void onLaunch()
                .catch((reason: unknown) => setError(errorMessage(reason)))
                .finally(() => {
                  busyRef.current = false
                  setBusy(false)
                })
            }}
          >
            Acknowledge and launch
          </button>
        </div>
      </section>
    </div>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
