import {
  forwardRef,
  useImperativeHandle,
  type ReactElement,
} from 'react'

import type { HarnessProviderId, HostPath } from '../../../shared'
import { HarnessProfileEditor } from './HarnessProfileEditor'
import {
  AddHarnessDialog,
  HarnessFolderPicker,
  UnsavedHarnessProfileDialog,
} from './HarnessProfileDialogs'
import {
  findProfileProbe,
  harnessProbeLabel,
  harnessRiskLabel,
} from './harness-profile-editor-policy'
import { useAddHarnessDialog } from './use-add-harness-dialog'
import { useHarnessFolderPicker } from './use-harness-folder-picker'
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
  useImperativeHandle(
    ref,
    () => ({ confirmSafeToLeave: editor.confirmSafeToLeave }),
    [editor.confirmSafeToLeave],
  )

  if (!workspaceRoot || !projectRoot) {
    return <p className="settings-harness-empty">Open a project to configure harnesses.</p>
  }

  return (
    <section className="settings-harnesses" aria-labelledby="settings-harnesses-title">
      <header>
        <div>
          <h3 id="settings-harnesses-title" tabIndex={-1}>
            Harnesses
          </h3>
          <p>
            Launch profiles keep argv, environment, paths, and recovery identity
            structured.
          </p>
        </div>
        <div className="settings-harness-actions">
          <button
            type="button"
            disabled={editor.busy}
            onClick={() => editor.probeAvailability(editor.profiles, true)}
          >
            Refresh availability
          </button>
          <button
            type="button"
            disabled={editor.busy || editor.providers.length === 0}
            onClick={() => editor.runAfterDraftGuard(() => editor.setAddOpen(true))}
          >
            Add a harness…
          </button>
        </div>
      </header>
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
                {editor.providers.find((candidate) => candidate.id === profile.providerId)
                  ?.displayName ?? profile.providerId}
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
        ) : null}
      </div>
      <HarnessProfileOverlays root={workspaceRoot} editor={editor} />
    </section>
  )
})

function HarnessProfileOverlays({
  root,
  editor,
}: {
  readonly root: HostPath
  readonly editor: ReturnType<typeof useHarnessProfileEditor>
}): ReactElement {
  const add = useAddHarnessDialog({
    open: editor.addOpen,
    providers: editor.providers,
    profiles: editor.profiles,
    root,
    onMaterialized: editor.materialized,
  })
  const folder = useHarnessFolderPicker(root, Boolean(editor.picker))
  return (
    <>
      {editor.picker ? (
        <HarnessFolderPicker
          root={root}
          current={folder.current}
          parent={folder.parent}
          directories={folder.directories}
          error={folder.error}
          onCancel={editor.closePicker}
          onNavigate={folder.navigate}
          onSelect={editor.authorizeBinding}
        />
      ) : null}
      {editor.addOpen ? (
        <AddHarnessDialog
          providers={editor.providers}
          configuredProviderIds={add.configuredProviderIds}
          pending={add.pending}
          selected={add.selected}
          detected={add.detected}
          manualProviderId={add.manualProviderId}
          busy={add.busy}
          error={add.error}
          onCancel={() => editor.setAddOpen(false)}
          onRefresh={add.refresh}
          onToggle={add.toggle}
          onManualProvider={(providerId: HarnessProviderId) =>
            add.setManualProviderId(providerId)
          }
          onManual={editor.manualProfile}
          onMaterialize={add.materialize}
        />
      ) : null}
      {editor.unsavedPromptOpen && editor.draft ? (
        <UnsavedHarnessProfileDialog
          profileName={editor.draft.input.displayName || 'Untitled profile'}
          busy={editor.busy}
          error={editor.error}
          onKeepEditing={() => editor.resolveUnsavedPrompt(false)}
          onDiscard={() => {
            editor.discardDraft()
            editor.resolveUnsavedPrompt(true)
          }}
          onSave={async () => {
            if (await editor.save()) editor.resolveUnsavedPrompt(true)
          }}
        />
      ) : null}
    </>
  )
}
