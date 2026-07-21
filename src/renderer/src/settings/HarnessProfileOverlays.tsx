import type { ReactElement } from 'react'

import type { HarnessProviderId, HostPath } from '../../../shared'
import {
  AddHarnessDialog,
  HarnessFolderPicker,
  UnsavedHarnessProfileDialog,
} from './HarnessProfileDialogs'
import { useAddHarnessDialog } from './use-add-harness-dialog'
import { useHarnessFolderPicker } from './use-harness-folder-picker'
import type { useHarnessProfileEditor } from './use-harness-profile-editor'

export function HarnessProfileOverlays({
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
      {editor.addOpen && editor.loadState === 'ready' ? (
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
