import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from 'react'

interface PaneResizerProps {
  readonly orientation: 'horizontal' | 'vertical'
  readonly label: string
  readonly className: string
  readonly onDrag: (clientPosition: number) => void
  readonly onDragStart?: () => void
  readonly onNudge: (delta: number) => void
  readonly onReset: () => void
  readonly action?: ReactElement
}

const KEYBOARD_STEP = 16
const ACTION_DRAG_THRESHOLD = 4

interface PointerSession {
  readonly id: number
  readonly startX: number
  readonly startY: number
  readonly captureTarget: Element
  readonly fromAction: boolean
  dragging: boolean
}

export function PaneResizer({
  orientation,
  label,
  className,
  onDrag,
  onDragStart,
  onNudge,
  onReset,
  action,
}: PaneResizerProps): ReactElement {
  const [dragging, setDragging] = useState(false)
  const pointerSessionRef = useRef<PointerSession | undefined>(undefined)
  const suppressActionClickRef = useRef(false)
  const clickResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current)
      releasePointer(pointerSessionRef.current)
      clearResizeClasses()
    },
    [],
  )

  const beginDrag = (session: PointerSession): void => {
    if (session.dragging) return
    session.dragging = true
    if (session.fromAction) suppressActionClickRef.current = true
    onDragStart?.()
    setDragging(true)
    document.body.classList.add(
      'pane-resizing',
      orientation === 'vertical' ? 'pane-resizing-column' : 'pane-resizing-row',
    )
  }

  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false): void => {
    const session = pointerSessionRef.current
    if (!session || session.id !== event.pointerId) return
    pointerSessionRef.current = undefined
    releasePointer(session)
    setDragging(false)
    clearResizeClasses()
    if (cancelled) {
      suppressActionClickRef.current = false
      if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current)
      clickResetTimerRef.current = undefined
      return
    }
    if (!session.fromAction || !session.dragging) return
    if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current)
    clickResetTimerRef.current = setTimeout(() => {
      suppressActionClickRef.current = false
      clickResetTimerRef.current = undefined
    }, 0)
  }

  const suppressCompletedDragClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (
      !suppressActionClickRef.current ||
      !(event.target instanceof Element) ||
      !event.target.closest('[data-resizer-action]')
    ) {
      return
    }
    suppressActionClickRef.current = false
    if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current)
    clickResetTimerRef.current = undefined
    event.preventDefault()
    event.stopPropagation()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let delta = 0
    if (orientation === 'vertical') {
      if (event.key === 'ArrowLeft') delta = -KEYBOARD_STEP
      if (event.key === 'ArrowRight') delta = KEYBOARD_STEP
    } else {
      // Moving the horizontal divider upward makes the terminal taller.
      if (event.key === 'ArrowUp') delta = KEYBOARD_STEP
      if (event.key === 'ArrowDown') delta = -KEYBOARD_STEP
    }
    if (delta === 0) return
    event.preventDefault()
    onNudge(delta)
  }

  return (
    <div
      className={`pane-resizer ${className}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      onDoubleClick={onReset}
      onClickCapture={suppressCompletedDragClick}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        suppressActionClickRef.current = false
        if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current)
        clickResetTimerRef.current = undefined
        const actionTarget =
          event.target instanceof Element
            ? event.target.closest('[data-resizer-action]')
            : null
        const session: PointerSession = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          captureTarget: actionTarget ?? event.currentTarget,
          fromAction: Boolean(actionTarget),
          dragging: false,
        }
        pointerSessionRef.current = session
        capturePointer(session)
        if (!session.fromAction) {
          event.preventDefault()
          beginDrag(session)
        }
      }}
      onPointerMove={(event) => {
        const session = pointerSessionRef.current
        if (!session || session.id !== event.pointerId) return
        if (
          !session.dragging &&
          Math.hypot(event.clientX - session.startX, event.clientY - session.startY) <
            ACTION_DRAG_THRESHOLD
        ) {
          return
        }
        if (!session.dragging) beginDrag(session)
        event.preventDefault()
        onDrag(orientation === 'vertical' ? event.clientX : event.clientY)
      }}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => finishDrag(event, true)}
      onLostPointerCapture={(event) => finishDrag(event, true)}
      title={`${label}. Double-click to reset.`}
    >
      {action}
    </div>
  )
}

function capturePointer(session: PointerSession): void {
  try {
    session.captureTarget.setPointerCapture(session.id)
  } catch {
    // Synthetic events and a cancelled native pointer may not be capturable.
  }
}

function releasePointer(session: PointerSession | undefined): void {
  if (!session) return
  try {
    if (session.captureTarget.hasPointerCapture(session.id)) {
      session.captureTarget.releasePointerCapture(session.id)
    }
  } catch {
    // Capture may already have been released by pointer cancellation.
  }
}

function clearResizeClasses(): void {
  document.body.classList.remove(
    'pane-resizing',
    'pane-resizing-row',
    'pane-resizing-column',
  )
}
