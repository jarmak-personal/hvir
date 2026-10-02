import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { displayHostPath } from '../../../shared'
import { PATH_COPY_LABELS, type PathCopyKind } from '../path-copy/path-copy'
import { FileOrganizationDialog } from './FileOrganizationDialog'
import { FileDeletionDialog } from './FileDeletionDialog'
import { FileExternalMoveDialog } from './FileExternalMoveDialog'
import { projectFileEntryNameError } from './project-file-entry-name'
import { fileManagerRevealLabel } from './file-manager-reveal'
import type { FileCreateActionsController } from './use-file-create-actions'

export function FileCreateOverlays({
  controller,
}: {
  readonly controller: FileCreateActionsController
}): ReactElement | null {
  const { menu, dialog, feedback, copyProgress } = controller
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPosition = useViewportContextMenuPosition(menuRef, menu)
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  const [name, setName] = useState('')
  const validation = projectFileEntryNameError(name)

  useEffect(() => setName(''), [dialog?.id])
  useEffect(() => {
    if (!menu) return
    if (menu.focusMenu) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }
    const dismissPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        controllerRef.current.dismissMenu()
      }
    }
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') controllerRef.current.dismissMenu(true)
    }
    document.addEventListener('pointerdown', dismissPointer)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissPointer)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [menu])

  if (
    !menu &&
    !dialog &&
    !controller.organization.dialog &&
    !controller.deletion.dialog &&
    !controller.externalMove.dialog &&
    !feedback &&
    !copyProgress
  ) {
    return null
  }
  return createPortal(
    <>
      {menu ? (
        <div
          ref={menuRef}
          className="file-action-menu viewport-context-menu hvir-scrollbar-obscuring"
          role="menu"
          aria-label={`File actions for ${menu.label}`}
          style={menuPosition}
          onKeyDown={moveMenuFocus}
        >
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginCreate('file')}
            className="hvir-button"
          >
            New File…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginCreate('directory')}
            className="hvir-button"
          >
            New Folder…
          </button>
          <div className="file-action-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('rename')}
            onClick={() => controller.beginOrganization('rename')}
            className="hvir-button"
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('move')}
            onClick={() => controller.beginOrganization('move')}
            className="hvir-button"
          >
            Move…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('duplicate')}
            onClick={() => controller.beginOrganization('duplicate')}
            className="hvir-button"
          >
            Duplicate…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              controller.pending || controller.deletion.menu.state !== 'available'
            }
            title={
              controller.deletion.menu.state === 'unavailable'
                ? controller.deletion.menu.reason
                : undefined
            }
            onClick={() => controller.beginDeletion()}
            className="hvir-button"
          >
            {deletionMenuLabel(controller.deletion.menu)}
          </button>
          <div className="file-action-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.pasteFilesFromMenu()}
            className="hvir-button"
          >
            Paste Files
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginExternalMove()}
            className="hvir-button"
          >
            Move External Items Here…
          </button>
          <div className="file-action-menu-separator" role="separator" />
          {(Object.keys(PATH_COPY_LABELS) as PathCopyKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              disabled={controller.pending}
              onClick={() => controller.copyPath(kind)}
              className="hvir-button"
            >
              {PATH_COPY_LABELS[kind]}
            </button>
          ))}
          {controller.canRevealInFileManager ? (
            <>
              <div className="file-action-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={controller.pending}
                onClick={() => controller.revealInFileManager()}
                className="hvir-button"
              >
                {fileManagerRevealLabel()}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {dialog ? (
        <div className="modal-backdrop">
          <form
            className="project-dialog confirmation-dialog file-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-create-title"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              controller.submitCreate(name)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') controller.dismissDialog()
            }}
          >
            <div className="confirmation-dialog-content">
              <h2 id="file-create-title">
                {dialog.kind === 'file' ? 'New File' : 'New Folder'}
              </h2>
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
              </dl>
              <label>
                Name
                <input
                  autoFocus
                  value={name}
                  disabled={controller.pending}
                  aria-invalid={Boolean(name && validation)}
                  onChange={(event) => setName(event.currentTarget.value)}
                  className="hvir-input hvir-control"
                />
              </label>
              {(controller.dialogError ?? (name ? validation : undefined)) ? (
                <div className="file-create-error" role="alert">
                  {controller.dialogError ?? validation}
                </div>
              ) : null}
            </div>
            <div className="dialog-actions confirmation-dialog-actions">
              <button
                className="confirmation-action confirmation-action-cancel hvir-button hvir-control"
                type="button"
                onClick={() => controller.dismissDialog()}
              >
                Cancel
              </button>
              <button
                className="confirmation-action confirmation-action-primary hvir-button hvir-control"
                type="submit"
                disabled={controller.pending || Boolean(validation)}
              >
                {controller.pending
                  ? 'Creating…'
                  : dialog.kind === 'file'
                    ? 'Create File'
                    : 'Create Folder'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      <FileOrganizationDialog controller={controller.organization} />
      <FileDeletionDialog controller={controller.deletion} />
      <FileExternalMoveDialog controller={controller.externalMove} />
      {feedback ? (
        <div
          className={`file-operation-feedback ${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{feedback.message}</span>
          {feedback.details?.length ? (
            <ul>
              {feedback.details.map((detail, index) => (
                <li key={`${index}:${detail}`}>{detail}</li>
              ))}
            </ul>
          ) : null}
          {feedback.kind === 'error' || feedback.details?.length ? (
            <button
              type="button"
              onClick={() => controller.dismissFeedback()}
              className="hvir-button"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {copyProgress ? (
        <div className="file-copy-progress" role="status" aria-live="polite">
          <span>
            {progressLabel(copyProgress.phase)} {copyProgress.completedItems} of{' '}
            {copyProgress.totalItems}
            {copyProgress.currentName ? ` · ${copyProgress.currentName}` : ''}
          </span>
          <button
            type="button"
            disabled={copyProgress.phase === 'cancelling'}
            onClick={() => controller.cancelCopy()}
            className="hvir-button"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </>,
    document.body,
  )
}

function progressLabel(
  phase: FileCreateActionsController['copyProgress'] extends infer _Progress
    ? NonNullable<FileCreateActionsController['copyProgress']>['phase']
    : never,
): string {
  switch (phase) {
    case 'cancelling':
      return 'Cancelling'
    case 'renaming':
      return 'Renaming'
    case 'moving':
      return 'Moving'
    case 'moving-external':
      return 'Moving external items'
    case 'duplicating':
      return 'Duplicating'
    case 'deleting':
      return 'Deleting'
    default:
      return 'Copying'
  }
}

function deletionMenuLabel(
  menu: FileCreateActionsController['deletion']['menu'],
): string {
  if (menu.state === 'loading') return 'Checking deletion…'
  if (menu.state === 'available') {
    return menu.disclosure.recovery === 'recoverable'
      ? 'Move to Trash…'
      : 'Delete Permanently…'
  }
  return 'Delete Unavailable'
}

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].filter((item) => !item.disabled)
  if (items.length === 0) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? items[0]
      : event.key === 'End'
        ? items.at(-1)
        : event.key === 'ArrowDown'
          ? items[(current + 1 + items.length) % items.length]
          : items[(current - 1 + items.length) % items.length]
  next?.focus()
}
