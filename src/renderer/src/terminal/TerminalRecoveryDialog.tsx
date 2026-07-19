import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type TerminalRecoverySession,
} from '../../../shared'
import { recoverableProfile } from './terminal-profile-recovery'
import { terminalRecoveryCandidateDecision } from './terminal-recovery-planner'
import { probeLaunchUnavailable, recoveryProbe } from './terminal-probe-policy'

export function TerminalRecoveryDialog({
  sessions,
  providers,
  profiles,
  probes,
  onCancel,
  onResume,
  onRebind,
}: {
  readonly sessions: readonly TerminalRecoverySession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly onCancel: () => void
  readonly onResume: (ids: ReadonlySet<string>) => void
  readonly onRebind: (
    record: TerminalRecoverySession,
    profile: HarnessProfile,
  ) => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        sessions
          .filter(
            (session) =>
              providerDescriptor(providers, session.providerId) !== undefined &&
              recoverableProfile(profiles, session) !== undefined &&
              !probeLaunchUnavailable(recoveryProbe(probes, session)),
          )
          .map((session) => session.id),
      ),
  )
  const [rebind, setRebind] = useState<Readonly<Record<string, HarnessProfileId>>>({})
  const [error, setError] = useState<string>()
  onCancelRef.current = onCancel

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
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
        className="project-dialog terminal-recovery-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-recovery-title"
        tabIndex={-1}
      >
        <h2 id="terminal-recovery-title">Restore terminals</h2>
        <div className="terminal-recovery-list">
          {sessions.map((session) => {
            const provider = providerDescriptor(providers, session.providerId)
            const profile = recoverableProfile(profiles, session)
            const probe = recoveryProbe(probes, session)
            const decision = terminalRecoveryCandidateDecision(
              session,
              providers,
              profiles,
              probes,
            )
            const sameProviderProfiles = profiles.filter(
              (candidate) => candidate.providerId === session.providerId,
            )
            const selectedRebindProfile = sameProviderProfiles.find(
              (candidate) =>
                candidate.id === (rebind[session.id] ?? sameProviderProfiles[0]?.id),
            )
            return (
              <div key={session.id} className="terminal-recovery-option">
                <input
                  type="checkbox"
                  aria-label={`Restore ${session.title}`}
                  disabled={!provider || !profile || probeLaunchUnavailable(probe)}
                  checked={selected.has(session.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(session.id)
                      else next.delete(session.id)
                      return next
                    })
                  }}
                />
                <span>
                  <strong>{session.title}</strong>
                  <small>
                    {profile?.displayName ??
                      provider?.displayName ??
                      `Unavailable provider (${session.providerId})`}{' '}
                    · {basenameHostPath(session.cwd)} ·{' '}
                    {provider && profile
                      ? `${profile.builtIn ? 'New shell' : `${recoveryActionLabel(decision.action)} · ${probeLabel(probe)}`}${profile.risk === 'standard' ? '' : ` · acknowledge ${riskLabel(profile.risk)}`}`
                      : decision.action === 'unavailable'
                        ? decision.reason
                        : 'Cannot restore'}
                  </small>
                  {provider && !profile && sameProviderProfiles.length > 0 ? (
                    <span className="terminal-recovery-rebind">
                      <select
                        aria-label={`Rebind ${session.title} profile`}
                        value={rebind[session.id] ?? sameProviderProfiles[0]?.id}
                        onChange={(event) => {
                          const profileId = event.currentTarget.value as HarnessProfileId
                          setRebind((current) => ({
                            ...current,
                            [session.id]: profileId,
                          }))
                        }}
                      >
                        {sameProviderProfiles.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.displayName}
                            {candidate.risk === 'standard'
                              ? ''
                              : ` · ${riskLabel(candidate.risk)}`}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedRebindProfile) return
                          void onRebind(session, selectedRebindProfile).catch(
                            (reason: unknown) => setError(errorMessage(reason)),
                          )
                        }}
                      >
                        {selectedRebindProfile?.risk === 'standard' ||
                        !selectedRebindProfile
                          ? 'Review and rebind'
                          : `Rebind and acknowledge ${riskLabel(selectedRebindProfile.risk)}`}
                      </button>
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Not now
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onResume(selected)}
          >
            Restore selected
          </button>
        </div>
      </section>
    </div>
  )
}

function providerDescriptor(
  providers: readonly HarnessProviderDescriptor[],
  id: TerminalRecoverySession['providerId'],
): HarnessProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id)
}

function recoveryActionLabel(
  action: 'new-shell' | 'resume' | 'restart' | 'unavailable',
): string {
  return action === 'resume' ? 'Resume' : 'New session'
}

function probeLabel(probe: HarnessProfileProbe | undefined): string {
  if (!probe) return 'Unchecked'
  switch (probe.status) {
    case 'available':
      return probe.version ?? 'Available'
    case 'executable-missing':
      return 'Executable missing'
    case 'version-unsupported':
      return 'Version incompatible'
    case 'capability-absent':
      return 'Capability unavailable'
    case 'authentication-required':
      return 'Authentication needed'
    case 'disconnected':
      return 'Host disconnected'
    case 'timeout':
      return 'Probe timed out'
    case 'malformed-output':
      return 'Version unknown'
    case 'probe-failed':
      return 'Probe failed'
    case 'unchecked':
      return 'Unchecked'
  }
}

function riskLabel(risk: HarnessProfile['risk']): string {
  return risk === 'elevated'
    ? 'Elevated'
    : risk === 'unclassified'
      ? 'Unclassified'
      : 'Standard'
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
