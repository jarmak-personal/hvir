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
    <div className="modal-backdrop">
      <form
        className="project-dialog confirmation-dialog file-create-dialog file-deletion-dialog"
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
        <div className="confirmation-dialog-content">
          <h2 id="file-deletion-title">
            {permanent ? 'Delete Permanently' : 'Move to Trash'}
          </h2>
          <p>
            {permanent ? (
              <>
                Permanently delete <code>{displayHostPath(dialog.source)}</code>? This
                cannot be undone.
              </>
            ) : (
              <>
                Are you sure you want to move{' '}
                <code>{displayHostPath(dialog.source)}</code> to Trash?
              </>
            )}
          </p>
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
          ) : null}
          {controller.dialogError ? (
            <div className="file-create-error" role="alert">
              {controller.dialogError}
            </div>
          ) : null}
        </div>
        <div className="dialog-actions confirmation-dialog-actions">
          <button
            ref={cancelRef}
            className="confirmation-action confirmation-action-cancel"
            type="button"
            disabled={controller.pending}
            onClick={() => controller.dismiss()}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="confirmation-action confirmation-action-destructive"
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
