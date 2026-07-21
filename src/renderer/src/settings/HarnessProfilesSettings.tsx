import { forwardRef, useImperativeHandle, type ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import { HarnessProfileEditor } from './HarnessProfileEditor'
import { HarnessProfileOverlays } from './HarnessProfileOverlays'
import {
  findProfileProbe,
  harnessProbeLabel,
  harnessRiskLabel,
} from './harness-profile-editor-policy'
import { SettingsSection } from './SettingsSection'
import { useHarnessProfileEditor } from './use-harness-profile-editor'

interface HarnessProfilesSettingsProps {
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialAddOpen?: boolean
}

export interface HarnessProfilesSettingsHandle {
  /** Resolves after the user saves, discards, or cancels an outstanding profile draft. */
  readonly confirmSafeToLeave: () => Promise<boolean>
}

export const HarnessProfilesSettings = forwardRef<
  HarnessProfilesSettingsHandle,
  HarnessProfilesSettingsProps
>(function HarnessProfilesSettings(
  { workspaceRoot, projectRoot, initialAddOpen = false },
  ref,
): ReactElement {
  const editor = useHarnessProfileEditor({
    workspaceRoot,
    projectRoot,
    initialAddOpen,
  })
  useImperativeHandle(ref, () => ({ confirmSafeToLeave: editor.confirmSafeToLeave }), [
    editor.confirmSafeToLeave,
  ])

  const actions =
    workspaceRoot && projectRoot ? (
      <div className="settings-harness-actions">
        <button
          type="button"
          disabled={editor.busy || editor.loadState !== 'ready'}
          onClick={() => editor.probeAvailability(editor.profiles, true)}
        >
          Refresh availability
        </button>
        <button
          type="button"
          disabled={
            editor.busy || editor.loadState !== 'ready' || editor.providers.length === 0
          }
          onClick={() => editor.runAfterDraftGuard(() => editor.setAddOpen(true))}
        >
          Add a harness…
        </button>
      </div>
    ) : null

  return (
    <SettingsSection
      section="harnesses"
      title="Harnesses"
      description="Configure structured launch profiles, availability, and recovery identity."
      actions={actions}
      className="settings-harnesses"
    >
      {!workspaceRoot || !projectRoot ? (
        <div className="settings-section-scroll settings-harness-state">
          <p>Open a project to configure harnesses.</p>
        </div>
      ) : editor.loadState === 'loading' ? (
        <div
          className="settings-section-scroll settings-harness-state"
          aria-live="polite"
        >
          <p>Loading harness providers…</p>
        </div>
      ) : editor.loadState === 'error' ? (
        <div className="settings-section-scroll settings-harness-state" role="alert">
          <p>Harness profiles could not be loaded.</p>
          {editor.error ? <p className="dialog-error">{editor.error}</p> : null}
          <button type="button" onClick={editor.reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="settings-harness-layout">
            <nav className="settings-profile-list" aria-label="Harness profiles">
              {editor.profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={editor.draft?.id === profile.id ? 'active' : undefined}
                  onClick={() => editor.selectProfile(profile)}
                >
                  <strong>{profile.displayName}</strong>
                  <small>
                    {editor.providers.find(
                      (candidate) => candidate.id === profile.providerId,
                    )?.displayName ?? profile.providerId}
                    {profile.risk === 'standard'
                      ? ''
                      : ` · ${harnessRiskLabel(profile.risk)}`}
                    {' · '}
                    {profile.builtIn
                      ? 'Always available'
                      : editor.pendingProbeIds.has(profile.id)
                        ? 'Checking…'
                        : harnessProbeLabel(
                            findProfileProbe(
                              editor.profileProbes,
                              profile,
                              workspaceRoot.hostId,
                            ),
                          )}
                  </small>
                </button>
              ))}
            </nav>
            {editor.draft ? (
              <HarnessProfileEditor
                draft={editor.draft}
                providers={editor.providers}
                provider={editor.provider}
                providerProbe={editor.providerProbe}
                previews={editor.previews}
                previewError={editor.previewError}
                error={editor.error}
                busy={editor.busy}
                dirty={editor.dirty}
                deleteArmed={editor.deleteArmed}
                workspaceRoot={workspaceRoot}
                projectRoot={projectRoot}
                onUpdateInput={editor.updateInput}
                onArguments={editor.setArguments}
                onAuthorizeExecutable={() => void editor.authorizeExecutable()}
                onPickBinding={editor.openPicker}
                onDuplicate={() =>
                  editor.runAfterDraftGuard(() => void editor.duplicate())
                }
                onRemove={() => {
                  if (editor.deleteArmed) {
                    editor.runAfterDraftGuard(() => void editor.remove())
                  } else {
                    void editor.remove()
                  }
                }}
                onSave={() => void editor.save()}
              />
            ) : (
              <p className="settings-harness-empty">No harness profiles are available.</p>
            )}
          </div>
          <HarnessProfileOverlays root={workspaceRoot} editor={editor} />
        </>
      )}
    </SettingsSection>
  )
})
