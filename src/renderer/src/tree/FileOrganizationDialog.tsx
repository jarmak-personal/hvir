import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'

import {
  basenameHostPath,
  displayHostPath,
  unwrapOperation,
  type HostPath,
} from '../../../shared'
import { DirectoryTree } from './DirectoryTree'
import { projectFileEntryNameError } from './project-file-entry-name'
import type { FileOrganizationActionsController } from './use-file-organization-actions'

export function FileOrganizationDialog({
  controller,
}: {
  readonly controller: FileOrganizationActionsController
}): ReactElement | null {
  const { dialog } = controller
  const [name, setName] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setName(dialog?.action === 'rename' ? basenameHostPath(dialog.source) : '')
  }, [dialog?.id, dialog?.action, dialog?.source])
  useEffect(() => {
    if (dialog?.action !== 'move') return
    pickerRef.current
      ?.querySelector<HTMLButtonElement>('[role="treeitem"][aria-selected="true"]')
      ?.focus()
  }, [dialog?.action, dialog?.id])

  if (!dialog) return null
  const needsName = dialog.action !== 'move'
  const validation = needsName ? projectFileEntryNameError(name) : undefined
  const verb = organizationVerb(dialog.action)
  return (
    <div className="modal-backdrop">
      <form
        className="project-dialog confirmation-dialog file-create-dialog file-organization-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-organization-title"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          controller.submit(name)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') controller.dismiss()
        }}
      >
        <div className="confirmation-dialog-content">
          <h2 id="file-organization-title">{verb} Entry</h2>
          <dl>
            <PathFact label="Workspace" path={dialog.workspaceRoot} />
            <PathFact label="Source" path={dialog.source} />
            {dialog.action !== 'rename' ? (
              <PathFact label="Destination" path={dialog.destinationDirectory} />
            ) : null}
          </dl>
          {dialog.action !== 'rename' ? (
            <div
              ref={pickerRef}
              className="file-organization-picker"
              role="group"
              aria-labelledby="file-organization-directory-label"
            >
              <span id="file-organization-directory-label">Destination folder</span>
              <DirectoryTree
                root={dialog.workspaceRoot}
                rootLabel={
                  basenameHostPath(dialog.workspaceRoot) || dialog.workspaceRoot.path
                }
                loadEntries={loadProjectEntries}
                selected={dialog.destinationDirectory}
                showFiles={false}
                onSelectDirectory={(path) => controller.selectDirectory(path)}
              />
            </div>
          ) : null}
          {needsName ? (
            <label>
              Name
              <input
                autoFocus
                value={name}
                disabled={controller.pending}
                aria-invalid={Boolean(name && validation)}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {(controller.dialogError ?? (name ? validation : undefined)) ? (
            <div className="file-create-error" role="alert">
              {controller.dialogError ?? validation}
            </div>
          ) : null}
        </div>
        <div className="dialog-actions confirmation-dialog-actions">
          <button
            className="confirmation-action confirmation-action-cancel"
            type="button"
            disabled={controller.pending}
            onClick={() => controller.dismiss()}
          >
            Cancel
          </button>
          <button
            className="confirmation-action confirmation-action-primary"
            type="submit"
            disabled={controller.pending || Boolean(validation)}
          >
            {controller.pending ? `${verb}…` : verb}
          </button>
        </div>
      </form>
    </div>
  )
}

function PathFact({ label, path }: { readonly label: string; readonly path: HostPath }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{displayHostPath(path)}</code>
      </dd>
    </div>
  )
}

function organizationVerb(action: 'rename' | 'move' | 'duplicate'): string {
  return action === 'rename' ? 'Rename' : action === 'move' ? 'Move' : 'Duplicate'
}

function loadProjectEntries(path: HostPath) {
  return window.hvir.invoke('fs:readdir', { path }).then(unwrapOperation)
}
