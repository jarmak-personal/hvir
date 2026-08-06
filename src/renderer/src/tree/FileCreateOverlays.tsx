import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

import { displayHostPath } from '../../../shared'
import { PATH_COPY_LABELS, type PathCopyKind } from '../path-copy/path-copy'
import { FileOrganizationDialog } from './FileOrganizationDialog'
import { FileDeletionDialog } from './FileDeletionDialog'
import { FileExternalMoveDialog } from './FileExternalMoveDialog'
import { projectFileEntryNameError } from './project-file-entry-name'
import type { FileCreateActionsController } from './use-file-create-actions'

export function FileCreateOverlays({
  controller,
}: {
  readonly controller: FileCreateActionsController
}): ReactElement | null {
  const { menu, dialog, feedback, copyProgress } = controller
  const menuRef = useRef<HTMLDivElement>(null)
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
          className="file-action-menu"
          role="menu"
          aria-label={`File actions for ${menu.label}`}
          style={boundedMenuPosition(menu.x, menu.y)}
          onKeyDown={moveMenuFocus}
        >
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginCreate('file')}
          >
            New File…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginCreate('directory')}
          >
            New Folder…
          </button>
          <div className="file-action-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('rename')}
            onClick={() => controller.beginOrganization('rename')}
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('move')}
            onClick={() => controller.beginOrganization('move')}
          >
            Move…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending || !controller.canOrganizeMenu('duplicate')}
            onClick={() => controller.beginOrganization('duplicate')}
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
          >
            {deletionMenuLabel(controller.deletion.menu)}
          </button>
          <div className="file-action-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.pasteFilesFromMenu()}
          >
            Paste Files
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={controller.pending}
            onClick={() => controller.beginExternalMove()}
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
            >
              {PATH_COPY_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : null}
      {dialog ? (
        <div className="file-create-backdrop">
          <form
            className="file-create-dialog"
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
              />
            </label>
            {(controller.dialogError ?? (name ? validation : undefined)) ? (
              <div className="file-create-error" role="alert">
                {controller.dialogError ?? validation}
              </div>
            ) : null}
            <div className="file-create-actions">
              <button type="button" onClick={() => controller.dismissDialog()}>
                Cancel
              </button>
              <button type="submit" disabled={controller.pending || Boolean(validation)}>
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
            <button type="button" onClick={() => controller.dismissFeedback()}>
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

function boundedMenuPosition(
  x: number,
  y: number,
): { readonly left: number; readonly top: number } {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - 208)),
    top: Math.max(8, Math.min(y, window.innerHeight - 224)),
  }
}
