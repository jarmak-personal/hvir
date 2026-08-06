import { useEffect, useRef, type ReactElement } from 'react'

import { displayHostPath } from '../../../shared'
import type { ExternalFileMoveController } from './use-external-file-move'

export function FileExternalMoveDialog({
  controller,
}: {
  readonly controller: ExternalFileMoveController
}): ReactElement | null {
  const { dialog } = controller
  const selectionRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!dialog || controller.pending) return
    if (dialog.stage === 'confirmation') cancelRef.current?.focus()
    else selectionRef.current?.focus()
  }, [controller.pending, dialog])
  if (!dialog) return null
  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog confirmation-dialog file-create-dialog file-external-move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-external-move-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') controller.dismiss()
        }}
      >
        <div className="confirmation-dialog-content">
          <h2 id="file-external-move-title">Move External Items Here</h2>
          <dl>
            <div>
              <dt>Workspace</dt>
              <dd>
                <code>{displayHostPath(dialog.workspaceRoot)}</code>
              </dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd>
                <code>{displayHostPath(dialog.destinationDirectory)}</code>
              </dd>
            </div>
            <div>
              <dt>Source recovery</dt>
              <dd>Application-host Trash</dd>
            </div>
          </dl>
          {dialog.stage === 'selection' ? (
            <>
              <p>{dialog.disclosure.picker.limitation}</p>
              <p>
                Selected sources are copied and completely verified before hvir asks the
                application host to move each exact source to Trash. There is no permanent
                deletion fallback.
              </p>
            </>
          ) : (
            <>
              <p>
                Confirm these selected items. A source is reported as moved only after
                verified publication, resolved Trash, and confirmed absence at its exact
                granted path.
              </p>
              <ul className="file-external-move-items">
                {dialog.grant.items.map((item) => (
                  <li key={item.itemId}>
                    <code>{item.name}</code> — {item.type}
                    {item.reason ? ` — ${item.reason}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="dialog-actions confirmation-dialog-actions">
          {dialog.stage === 'selection' ? (
            <>
              <button
                className="confirmation-action confirmation-action-cancel"
                type="button"
                disabled={controller.pending}
                onClick={() => controller.dismiss()}
              >
                Cancel
              </button>
              {dialog.disclosure.picker.kind === 'mixed-multiple' ? (
                <button
                  ref={selectionRef}
                  className="confirmation-action confirmation-action-primary"
                  type="button"
                  disabled={controller.pending}
                  onClick={() => controller.choose('mixed')}
                >
                  Choose Files or Folders…
                </button>
              ) : (
                <>
                  <button
                    ref={selectionRef}
                    className="confirmation-action confirmation-action-primary"
                    type="button"
                    disabled={controller.pending}
                    onClick={() => controller.choose('files')}
                  >
                    Choose Files…
                  </button>
                  <button
                    className="confirmation-action confirmation-action-primary"
                    type="button"
                    disabled={controller.pending}
                    onClick={() => controller.choose('directory')}
                  >
                    Choose Folder…
                  </button>
                </>
              )}
            </>
          ) : (
            <>
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
                type="button"
                className="confirmation-action confirmation-action-destructive"
                disabled={controller.pending}
                onClick={() => controller.confirm()}
              >
                Move Selected Items
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
