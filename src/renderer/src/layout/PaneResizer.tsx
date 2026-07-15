import {
  useEffect,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react'

interface PaneResizerProps {
  readonly orientation: 'horizontal' | 'vertical'
  readonly label: string
  readonly className: string
  readonly onDrag: (clientPosition: number) => void
  readonly onNudge: (delta: number) => void
  readonly onReset: () => void
  readonly action?: ReactElement
}

const KEYBOARD_STEP = 16

export function PaneResizer({
  orientation,
  label,
  className,
  onDrag,
  onNudge,
  onReset,
  action,
}: PaneResizerProps): ReactElement {
  const [dragging, setDragging] = useState(false)

  useEffect(
    () => () => {
      document.body.classList.remove(
        'pane-resizing',
        'pane-resizing-row',
        'pane-resizing-column',
      )
    },
    [],
  )

  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    document.body.classList.remove(
      'pane-resizing',
      'pane-resizing-row',
      'pane-resizing-column',
    )
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
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-resizer-action]')
        ) {
          return
        }
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        document.body.classList.add(
          'pane-resizing',
          orientation === 'vertical' ? 'pane-resizing-column' : 'pane-resizing-row',
        )
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        onDrag(orientation === 'vertical' ? event.clientX : event.clientY)
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      title={`${label}. Double-click to reset.`}
    >
      {action}
    </div>
  )
}
