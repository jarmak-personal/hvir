import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'

import { basenameHostPath, displayHostPath } from '../../../shared'
import type { FileDeletionActionsController } from './use-file-deletion-actions'

export function FileDeletionDialog({
  controller,
}: {
  readonly controller: FileDeletionActionsController
}): ReactElement | null {
  const { dialog } = controller
  const [confirmation, setConfirmation] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setConfirmation('')
    if (dialog?.recovery === 'recoverable') cancelRef.current?.focus()
  }, [dialog?.id, dialog?.recovery])
  if (!dialog) return null
  const permanent = dialog.recovery === 'permanent'
  const entryName = basenameHostPath(dialog.source)
  return (
    <div className="file-create-backdrop">
      <form
        className="file-create-dialog file-deletion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-deletion-title"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          controller.confirm(confirmation)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') controller.dismiss()
        }}
      >
        <h2 id="file-deletion-title">
          {permanent ? 'Delete Permanently' : 'Move to Trash'}
        </h2>
        <dl>
          <div>
            <dt>Workspace</dt>
            <dd>
              <code>{displayHostPath(dialog.workspaceRoot)}</code>
            </dd>
          </div>
          <div>
            <dt>Entry</dt>
            <dd>
              <code>{displayHostPath(dialog.source)}</code>
            </dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{permanent ? 'Permanent deletion' : 'Move to operating-system Trash'}</dd>
          </div>
          <div>
            <dt>Recovery</dt>
            <dd>
              {permanent
                ? `None. ${dialog.source.hostId} does not provide recoverable deletion.`
                : 'Available through the operating-system Trash.'}
            </dd>
          </div>
        </dl>
        {permanent ? (
          <label>
            Type <strong>{entryName}</strong> to confirm
            <input
              autoFocus
              value={confirmation}
              disabled={controller.pending}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
          </label>
        ) : (
          <p>This entry can usually be restored from your operating-system Trash.</p>
        )}
        {controller.dialogError ? (
          <div className="file-create-error" role="alert">
            {controller.dialogError}
          </div>
        ) : null}
        <div className="file-create-actions">
          <button
            ref={cancelRef}
            type="button"
            disabled={controller.pending}
            onClick={() => controller.dismiss()}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="file-destructive-action"
            disabled={controller.pending || (permanent && confirmation !== entryName)}
          >
            {controller.pending
              ? 'Deleting…'
              : permanent
                ? 'Delete Permanently'
                : 'Move to Trash'}
          </button>
        </div>
      </form>
    </div>
  )
}
