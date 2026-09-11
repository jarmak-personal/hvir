import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SkillagerMetadata } from '../../../shared/skillager'
import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { exposureActions } from './skillager-exposure-model'
import type { SkillagerExposureController } from './use-skillager-exposure'

export function SkillagerActions({
  metadata,
  controller,
  children,
  active = true,
}: {
  readonly metadata: SkillagerMetadata
  readonly controller: SkillagerExposureController
  readonly active?: boolean
  readonly children?: ReactNode
}): ReactElement {
  const [anchor, setAnchor] = useState<{ id: number; x: number; y: number }>()
  const menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement>(null)
  const position = useViewportContextMenuPosition(menu, anchor)
  useEffect(
    () => setAnchor(undefined),
    [active, controller.context, controller.state, metadata.id],
  )
  useEffect(() => {
    if (!anchor) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setAnchor(undefined)
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setAnchor(undefined)
        trigger.current?.focus()
        return
      }
      if (
        !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
        !menu.current?.contains(document.activeElement)
      )
        return
      event.preventDefault()
      const items = [
        ...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      ]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowUp'
              ? (index - 1 + items.length) % items.length
              : (index + 1) % items.length
      items[next]?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', keyboard, true)
    }
  }, [anchor])
  const open = (element: HTMLElement, x?: number, y?: number): void => {
    trigger.current = element
    const bounds = element.getBoundingClientRect()
    setAnchor({ id: Date.now(), x: x ?? bounds.left, y: y ?? bounds.bottom })
  }
  return (
    <div
      className="skillager-action-row"
      onContextMenu={(event) => {
        event.preventDefault()
        open(
          (event.target as HTMLElement).closest('button') ??
            event.currentTarget.querySelector('button')!,
          event.clientX,
          event.clientY,
        )
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          open(event.target as HTMLElement)
        }
      }}
    >
      {children}
      <button
        type="button"
        className="skillager-actions-trigger"
        aria-label={`Actions for ${metadata.name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => open(event.currentTarget)}
      >
        ⋯
      </button>
      {anchor && active
        ? createPortal(
            <div
              ref={menu}
              className="path-copy-menu viewport-context-menu"
              role="menu"
              aria-label={`Skill actions for ${metadata.name}`}
              style={position}
            >
              {exposureActions(metadata).map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setAnchor(undefined)
                    trigger.current?.focus()
                    controller.start(metadata, item.action)
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
