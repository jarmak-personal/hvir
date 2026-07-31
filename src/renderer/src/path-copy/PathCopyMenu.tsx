import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { HostPath } from '../../../shared'
import { copyHostPath, PATH_COPY_LABELS, type PathCopyKind } from './path-copy'
import type { PathCopyMenuController } from './use-path-copy-menu'

interface PathCopyMenuProps {
  readonly workspaceRoot: HostPath
  readonly controller: PathCopyMenuController
  readonly writeText?: (value: string) => Promise<void>
}

interface PathCopyFeedback {
  readonly kind: 'success' | 'error'
  readonly message: string
}

export function PathCopyMenu({
  workspaceRoot,
  controller,
  writeText = writeApplicationClipboard,
}: PathCopyMenuProps): ReactElement | null {
  const { request } = controller
  const menuRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const latestRequest = useRef(request)
  const ownerKey = `${workspaceRoot.hostId}\0${workspaceRoot.path}`
  const latestOwnerKey = useRef(ownerKey)
  const [pending, setPending] = useState<PathCopyKind>()
  const [feedback, setFeedback] = useState<PathCopyFeedback>()
  latestRequest.current = request
  latestOwnerKey.current = ownerKey

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

  useEffect(() => {
    setPending(undefined)
    if (!request) return
    if (request.focusMenu) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }
    const dismissOnPointer = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) controller.dismiss()
    }
    const dismissOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') controller.dismiss(true)
    }
    document.addEventListener('pointerdown', dismissOnPointer)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointer)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [controller, request])

  const copy = (kind: PathCopyKind): void => {
    if (!request || pending) return
    const actionRequest = request
    const actionOwnerKey = ownerKey
    setPending(kind)
    void copyHostPath(workspaceRoot, actionRequest.target, kind, writeText).then(
      () => {
        if (!alive.current || latestOwnerKey.current !== actionOwnerKey) return
        setFeedback({
          kind: 'success',
          message: `${PATH_COPY_LABELS[kind].replace('Copy ', '')} copied.`,
        })
        if (latestRequest.current?.id === actionRequest.id) {
          controller.dismiss(true)
        }
      },
      () => {
        if (!alive.current || latestOwnerKey.current !== actionOwnerKey) return
        setFeedback({
          kind: 'error',
          message: 'Could not copy the path to the clipboard.',
        })
        if (latestRequest.current?.id === actionRequest.id) {
          controller.dismiss(true)
        }
      },
    )
  }

  if (!request && !feedback) return null
  return createPortal(
    <>
      {request ? (
        <div
          ref={menuRef}
          className="path-copy-menu"
          role="menu"
          aria-label={`Path actions for ${request.label}`}
          style={boundedMenuPosition(request.x, request.y)}
        >
          {(Object.keys(PATH_COPY_LABELS) as PathCopyKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              disabled={pending !== undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => copy(kind)}
            >
              {PATH_COPY_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : null}
      {feedback ? (
        <div
          className={`path-copy-feedback ${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}
        >
          {feedback.message}
        </div>
      ) : null}
    </>,
    document.body,
  )
}

function writeApplicationClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard writing is unavailable'))
  }
  return navigator.clipboard.writeText(value)
}

function boundedMenuPosition(
  x: number,
  y: number,
): {
  readonly left: number
  readonly top: number
} {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - 208)),
    top: Math.max(8, Math.min(y, window.innerHeight - 84)),
  }
}
