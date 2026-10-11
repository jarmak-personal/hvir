import { forwardRef, useImperativeHandle, type ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import { HarnessProfileToolbar } from './HarnessProfileToolbar'
import { HarnessProfileEditor } from './HarnessProfileEditor'
import { HarnessProfileOverlays } from './HarnessProfileOverlays'
import { findProfileProbe, harnessProbeLabel } from './harness-profile-editor-policy'
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
      <HarnessProfileToolbar
        busy={editor.busy}
        ready={editor.loadState === 'ready'}
        shellAvailable={Boolean(editor.shellProvider)}
        harnessAvailable={editor.providers.length > 0}
        onRefresh={() => editor.probeAvailability(editor.profiles, true)}
        onAddShell={() => editor.runAfterDraftGuard(editor.startShellProfile)}
        onAddHarness={() => editor.runAfterDraftGuard(() => editor.setAddOpen(true))}
      />
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
          <button type="button" onClick={editor.reload} className="hvir-button">
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
                  className={
                    editor.draft?.id === profile.id ? 'active hvir-button' : 'hvir-button'
                  }
                  aria-current={editor.draft?.id === profile.id ? 'true' : undefined}
                  onClick={() => editor.selectProfile(profile)}
                >
                  <strong>{profile.displayName}</strong>
                  <small>
                    {editor.providers.find(
                      (candidate) => candidate.id === profile.providerId,
                    )?.displayName ?? profile.providerId}
                    {' · '}
                    {profile.scope.kind === 'global' ? 'All projects' : 'This project'}
                    {' · '}
                    {editor.pendingProbeIds.has(profile.id)
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
              {editor.draft && !editor.draft.id ? (
                <button type="button" className="active hvir-button" aria-current="true">
                  <strong>{editor.draft.input.displayName || 'Untitled profile'}</strong>
                  <small>
                    {editor.provider?.displayName ?? editor.draft.input.providerId}
                    {' · '}
                    {editor.draft.input.scope.kind === 'global'
                      ? 'All projects'
                      : 'This project'}
                    {' · Unsaved'}
                  </small>
                </button>
              ) : null}
            </nav>
            {editor.draft ? (
              <HarnessProfileEditor
                draft={editor.draft}
                providers={editor.providers}
                provider={editor.provider}
                providerProbe={editor.providerProbe}
                previews={editor.previews}
                previewReadiness={editor.previewReadiness}
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
              <div className="settings-harness-empty">
                <strong>No configured harnesses yet</strong>
                <p>
                  Bare Shell remains available whenever you open a terminal. Add a profile
                  here only when you want custom shell or harness settings.
                </p>
                <div>
                  <button
                    type="button"
                    disabled={!editor.shellProvider}
                    onClick={editor.startShellProfile}
                    className="hvir-button"
                  >
                    Add a shell
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.setAddOpen(true)}
                    className="hvir-button"
                  >
                    Add a harness…
                  </button>
                </div>
              </div>
            )}
          </div>
          <HarnessProfileOverlays root={workspaceRoot} editor={editor} />
        </>
      )}
    </SettingsSection>
  )
})
