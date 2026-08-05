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
import {
  projectFileEntryNameError,
  type FileCreateActionsController,
} from './use-file-create-actions'

export function FileCreateOverlays({
  controller,
}: {
  readonly controller: FileCreateActionsController
}): ReactElement | null {
  const { menu, dialog, feedback } = controller
  const menuRef = useRef<HTMLDivElement>(null)
  const [name, setName] = useState('')
  const validation = projectFileEntryNameError(name)

  useEffect(() => setName(''), [dialog?.id])
  useEffect(() => {
    if (!menu) return
    if (menu.focusMenu) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }
    const dismissPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) controller.dismissMenu()
    }
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') controller.dismissMenu(true)
    }
    document.addEventListener('pointerdown', dismissPointer)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissPointer)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [controller, menu])

  if (!menu && !dialog && !feedback) return null
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
              <button
                type="button"
                disabled={controller.pending}
                onClick={() => controller.dismissDialog()}
              >
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
      {feedback ? (
        <div
          className={`file-operation-feedback ${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </div>
      ) : null}
    </>,
    document.body,
  )
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
