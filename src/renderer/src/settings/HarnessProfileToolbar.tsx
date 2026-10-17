import type { ReactElement } from 'react'

/** Feature-owned action layout; controller policy stays with the Settings editor. */
export function HarnessProfileToolbar({
  busy,
  ready,
  shellAvailable,
  harnessAvailable,
  onRefresh,
  onAddShell,
  onAddHarness,
}: {
  readonly busy: boolean
  readonly ready: boolean
  readonly shellAvailable: boolean
  readonly harnessAvailable: boolean
  readonly onRefresh: () => void
  readonly onAddShell: () => void
  readonly onAddHarness: () => void
}): ReactElement {
  return (
    <div className="settings-harness-actions">
      <button
        className="hvir-button"
        type="button"
        disabled={busy || !ready}
        onClick={onRefresh}
      >
        Refresh availability
      </button>
      <button
        className="hvir-button"
        type="button"
        disabled={busy || !ready || !shellAvailable}
        onClick={onAddShell}
      >
        Add a shell
      </button>
      <button
        className="hvir-button"
        type="button"
        disabled={busy || !ready || !harnessAvailable}
        onClick={onAddHarness}
      >
        Add a harness…
      </button>
    </div>
  )
}
