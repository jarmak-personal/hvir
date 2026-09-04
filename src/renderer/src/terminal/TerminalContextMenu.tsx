import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

import { boundTerminalContextMenuPosition } from './terminal-context-menu-position'
import { readApplicationClipboard, writeApplicationClipboard } from './terminal-clipboard'
import type {
  TerminalContextMenuController,
  TerminalContextMenuRequest,
} from './use-terminal-context-menu'
import type { TerminalForkAvailability } from './terminal-fork-policy'

type TerminalMenuAction = 'copy' | 'paste' | 'select-all' | 'clear' | 'reset'

interface TerminalContextMenuProps {
  readonly controller: TerminalContextMenuController
  readonly onSplit: () => void
  readonly onFork: () => void
  readonly forkAvailability: TerminalForkAvailability
  readonly onSearch: () => void
  readonly onOpenSettings: () => void
  readonly readText?: () => Promise<string>
  readonly writeText?: (value: string) => Promise<void>
}

export function TerminalContextMenu({
  controller,
  onSplit,
  onFork,
  forkAvailability,
  onSearch,
  onOpenSettings,
  readText = readApplicationClipboard,
  writeText = writeApplicationClipboard,
}: TerminalContextMenuProps): ReactElement | null {
  const { request } = controller
  const menuRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const currentRequest = useRef(request)
  const [pending, setPending] = useState<TerminalMenuAction>()
  const [feedback, setFeedback] = useState<string>()
  currentRequest.current = request

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!feedback) return
    const timeout = window.setTimeout(() => setFeedback(undefined), 4_000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  useLayoutEffect(() => {
    setPending(undefined)
    if (request) setFeedback(undefined)
    if (!request || !menuRef.current) return
    const menu = menuRef.current
    const bounds = menu.getBoundingClientRect()
    const position = boundTerminalContextMenuPosition(
      { x: request.x, y: request.y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: bounds.width, height: bounds.height },
    )
    menu.style.left = `${position.x}px`
    menu.style.top = `${position.y}px`
    menu.style.visibility = 'visible'
    if (request.focusMenu) firstEnabledMenuItem(menu)?.focus()
  }, [request])

  useEffect(() => {
    if (!request) return
    const dismissOnPointer = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) controller.dismiss()
    }
    const handleKeyboard = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        controller.dismiss(true)
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const menu = menuRef.current
      if (!menu?.contains(document.activeElement)) return
      event.preventDefault()
      focusRelativeMenuItem(menu, event.key)
    }
    document.addEventListener('pointerdown', dismissOnPointer)
    document.addEventListener('keydown', handleKeyboard, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointer)
      document.removeEventListener('keydown', handleKeyboard, true)
    }
  }, [controller, request])

  const acceptAsyncResult = (actionRequest: TerminalContextMenuRequest): boolean =>
    alive.current &&
    currentRequest.current?.id === actionRequest.id &&
    actionRequest.target.isCurrent()

  const copy = (): void => {
    if (!request || pending || !request.copyAvailable) return
    const actionRequest = request
    const selection = actionRequest.target.getSelection()
    if (selection === undefined) {
      controller.dismiss()
      return
    }
    setPending('copy')
    void writeText(selection).then(
      () => {
        if (!acceptAsyncResult(actionRequest)) return
        controller.dismiss(true)
      },
      () => {
        if (!acceptAsyncResult(actionRequest)) return
        setFeedback('Could not copy the selection to the clipboard.')
        controller.dismiss(true)
      },
    )
  }

  const paste = (): void => {
    if (!request || pending) return
    const actionRequest = request
    setPending('paste')
    void readText().then(
      (value) => {
        if (!acceptAsyncResult(actionRequest)) return
        if (value.length === 0) {
          setFeedback('Clipboard does not contain plain text.')
        } else {
          actionRequest.target.paste(value)
        }
        controller.dismiss(true)
      },
      () => {
        if (!acceptAsyncResult(actionRequest)) return
        setFeedback('Could not read plain text from the clipboard.')
        controller.dismiss(true)
      },
    )
  }

  const act = (
    action: Exclude<TerminalMenuAction, 'copy' | 'paste'>,
    invoke: (actionRequest: TerminalContextMenuRequest) => boolean,
  ): void => {
    if (!request || pending) return
    setPending(action)
    if (invoke(request)) controller.dismiss(true)
    else controller.dismiss()
  }

  const runWorkspaceAction = (callback: () => void): void => {
    if (!request || pending || !request.target.isCurrent()) {
      controller.dismiss()
      return
    }
    callback()
    controller.dismiss()
  }

  if (!request && !feedback) return null
  return createPortal(
    <>
      {request ? (
        <div
          ref={menuRef}
          className="terminal-context-menu"
          role="menu"
          aria-label="Terminal actions"
          style={{ left: 0, top: 0, visibility: 'hidden' }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!request.copyAvailable || pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={copy}
          >
            Copy Selection
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={paste}
          >
            Paste
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => runWorkspaceAction(onSearch)}
          >
            Search Terminal…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => act('select-all', ({ target }) => target.selectAll())}
          >
            Select All
          </button>
          <div className="terminal-context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => act('clear', ({ target }) => target.clear())}
          >
            Clear Screen and Scrollback
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => act('reset', ({ target }) => target.reset())}
          >
            Reset Terminal
          </button>
          <div className="terminal-context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => runWorkspaceAction(onSplit)}
          >
            Split Terminal
          </button>
          <button
            type="button"
            role="menuitem"
            className="terminal-context-menu-explained"
            disabled={!forkAvailability.available || pending !== undefined}
            title={forkAvailability.available ? undefined : forkAvailability.reason}
            onPointerDown={retainTerminalFocus}
            onClick={() => runWorkspaceAction(onFork)}
          >
            <span>Fork Conversation to New Terminal</span>
            {!forkAvailability.available ? (
              <span className="terminal-context-menu-reason">
                {forkAvailability.reason}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending !== undefined}
            onPointerDown={retainTerminalFocus}
            onClick={() => runWorkspaceAction(onOpenSettings)}
          >
            Terminal Settings…
          </button>
        </div>
      ) : null}
      {feedback ? (
        <div className="terminal-context-feedback" role="alert" aria-live="assertive">
          {feedback}
        </div>
      ) : null}
    </>,
    document.body,
  )
}

function retainTerminalFocus(event: ReactPointerEvent<HTMLButtonElement>): void {
  event.preventDefault()
}

function enabledMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
    (item) => !item.disabled,
  )
}

function firstEnabledMenuItem(menu: HTMLElement): HTMLButtonElement | undefined {
  return enabledMenuItems(menu)[0]
}

function focusRelativeMenuItem(menu: HTMLElement, key: string): void {
  const items = enabledMenuItems(menu)
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowUp'
          ? (index - 1 + items.length) % items.length
          : (index + 1) % items.length
  items[next]?.focus()
}
