import { useRef, type ReactElement } from 'react'

import type { HarnessProfile } from '../../../shared'
import {
  harnessLaunchMenuState,
  compactHarnessCapabilityLabel,
} from '../terminal/harness-launch-menu'
import { profileProbe } from '../terminal/terminal-probe-policy'
import { useModalKeyboard } from '../workbench/use-modal-keyboard'
import type { SessionsLaunchChoices } from './sessions-command-port'

export function SessionsLaunchDialog({
  projectName,
  choices,
  busy,
  feedback,
  onStart,
  onRefresh,
  onCancel,
}: {
  readonly projectName: string
  readonly choices?: SessionsLaunchChoices
  readonly busy: boolean
  readonly feedback?: string
  readonly onStart: (profile: HarnessProfile) => void
  readonly onRefresh: () => void
  readonly onCancel: () => void
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  useModalKeyboard(dialog, onCancel)
  return (
    <div className="sessions-detail-backdrop">
      <section
        ref={dialog}
        className="sessions-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessions-launch-title"
        tabIndex={-1}
      >
        <header>
          <h2 id="sessions-launch-title">New session · {projectName}</h2>
          <p>Start in the project’s root workspace.</p>
        </header>
        {feedback || (busy && !choices) ? (
          <p role="status">{feedback ?? 'Reading launch profiles…'}</p>
        ) : null}
        <div className="sessions-launch-choices">
          {choices?.profiles.map((profile) => {
            const provider = choices.providers.find(
              (candidate) => candidate.id === profile.providerId,
            )
            const state = harnessLaunchMenuState(
              profile,
              profileProbe(choices.probes, profile),
              false,
            )
            const capability = compactHarnessCapabilityLabel(
              provider?.default === true,
              state.probe?.capabilities ?? provider?.capabilities,
            )
            return (
              <button
                key={profile.id}
                type="button"
                disabled={busy || !provider || state.availability !== 'available'}
                onClick={() => onStart(profile)}
              >
                <strong>{profile.displayName}</strong>
                <small>
                  {[
                    capability,
                    profile.builtIn
                      ? undefined
                      : (state.probe?.detail ?? state.availability),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </button>
            )
          })}
        </div>
        <footer>
          <button type="button" disabled={busy || !choices} onClick={onRefresh}>
            Refresh availability
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </section>
    </div>
  )
}
