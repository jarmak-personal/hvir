import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { RenameTerminalRequest, TerminalName } from '../../../shared'
import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

/** Shared presentation command. Opening this interaction never activates a terminal. */
export function SessionRenameTarget({
  id,
  customName,
  nameRevision,
  children,
}: {
  readonly id: string
  readonly children: ReactNode
} & TerminalName): ReactElement {
  const [menu, setMenu] = useState<{ id: number; x: number; y: number }>()
  const [editing, setEditing] = useState<RenameTerminalRequest>()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const position = useViewportContextMenuPosition(menuRef, menu)
  useEffect(
    () => () => {
      generation.current += 1
    },
    [],
  )
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined)
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Tab') setMenu(undefined)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(undefined)
        origin.current?.focus()
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', keyboard)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', keyboard)
    }
  }, [menu])
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])
  const cancel = () => {
    setEditing(undefined)
    origin.current?.focus()
  }
  const save = () => {
    if (!editing || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    const captured = generation.current
    void window.hvir
      .invoke('terminal:rename', { ...editing, customName: value })
      .then((result) => {
        if (captured !== generation.current) return
        if (result.ok) cancel()
        else setError(result.error)
      })
      .catch(() => {
        if (captured === generation.current)
          setError('The session name could not be saved. Try again.')
      })
      .finally(() => {
        if (captured === generation.current) {
          pending.current = false
          setBusy(false)
        }
      })
  }
  const open = (element: HTMLElement, x: number, y: number) => {
    origin.current =
      element.closest<HTMLElement>('button, [tabindex]') ??
      element.querySelector<HTMLElement>('button, [tabindex]')
    setMenu({ id: Date.now(), x, y })
    setError(undefined)
  }
  return (
    <div
      className="session-rename-target"
      onContextMenu={(event) => {
        if (editing) return
        event.preventDefault()
        event.stopPropagation()
        open(event.target as HTMLElement, event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        if (editing) return
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
          return
        event.preventDefault()
        event.stopPropagation()
        const target = event.target as HTMLElement
        const bounds = target.getBoundingClientRect()
        open(target, bounds.left + 24, bounds.top + 24)
      }}
    >
      {children}
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Session actions"
              className="terminal-context-menu viewport-context-menu"
              style={position}
            >
              <button
                type="button"
                role="menuitem"
                className="hvir-button"
                onClick={() => {
                  setMenu(undefined)
                  setValue(customName ?? '')
                  setEditing({
                    id,
                    expectedNameRevision: nameRevision ?? 0,
                    customName: customName ?? '',
                  })
                }}
              >
                Rename…
              </button>
            </div>,
            document.body,
          )
        : null}
      {editing
        ? createPortal(
            <ConfirmationDialog
              labelledBy="session-rename-title"
              busy={busy}
              actions={[
                { label: 'Cancel', kind: 'cancel', onSelect: cancel },
                { label: 'Save name', kind: 'primary', onSelect: save },
              ]}
            >
              <h2 id="session-rename-title">Rename session</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  save()
                }}
              >
                <label>
                  Session name
                  <input
                    ref={inputRef}
                    data-modal-initial
                    value={value}
                    maxLength={512}
                    disabled={busy}
                    onChange={(event) => setValue(event.target.value)}
                  />
                </label>
                <p>Leave empty to use the automatic title.</p>
                {error ? <p role="alert">{error}</p> : null}
              </form>
            </ConfirmationDialog>,
            document.body,
          )
        : null}
    </div>
  )
}
