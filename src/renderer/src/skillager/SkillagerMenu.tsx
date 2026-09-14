import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { firstEnabledMenuItem, focusRelativeMenuItem } from '../context-menu/menu-focus'
import {
  useViewportContextMenuPosition,
  type ContextMenuAnchor,
} from '../context-menu/viewport-context-menu'

/** Skills popup mechanics only; each caller retains request validity and action policy. */
export function SkillagerMenu({
  anchor,
  label,
  dismiss,
  items,
}: {
  readonly anchor: ContextMenuAnchor
  readonly label: string
  readonly dismiss: (restoreFocus?: boolean) => void
  readonly items: readonly {
    readonly id: string
    readonly label: string
    readonly disabled?: boolean
    readonly select: () => void
  }[]
}) {
  const menu = useRef<HTMLDivElement>(null)
  const position = useViewportContextMenuPosition(menu, anchor)
  useEffect(() => {
    if (menu.current) firstEnabledMenuItem(menu.current)?.focus()
    const outside = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node)) dismiss()
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismiss(true)
        return
      }
      if (
        menu.current?.contains(document.activeElement) &&
        focusRelativeMenuItem(menu.current, event.key)
      )
        event.preventDefault()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', keyboard, true)
    }
  }, [anchor, dismiss])
  return createPortal(
    <div
      ref={menu}
      className="path-copy-menu viewport-context-menu"
      role="menu"
      aria-label={label}
      style={position}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={item.select}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
