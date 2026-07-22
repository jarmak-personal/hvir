import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HarnessProfile, HarnessProviderDescriptor } from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

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
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const launch = (): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    void onLaunch()
      .catch((reason: unknown) => {
        if (mountedRef.current) setError(errorMessage(reason))
      })
      .finally(() => {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      })
  }

  return (
    <ConfirmationDialog
      labelledBy="harness-risk-title"
      actions={[
        { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
        {
          label: 'Acknowledge and launch',
          kind: 'primary',
          onSelect: launch,
        },
      ]}
      busy={busy}
      className="harness-risk-dialog"
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
    </ConfirmationDialog>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
