import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SkillagerMetadata } from '../../../shared/skillager'
import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { firstEnabledMenuItem, focusRelativeMenuItem } from '../context-menu/menu-focus'
import { exposureActions } from './skillager-exposure-model'
import type { SkillagerExposureController } from './use-skillager-exposure'
import type { SkillagerActionSurface } from './use-skillager-actions'

type MenuController = SkillagerExposureController['menu']
/** Rows and details are stateless triggers; the feature renders one menu host. */
export function SkillagerActions({
  metadata,
  controller,
  children,
  surface,
}: {
  readonly metadata: SkillagerMetadata
  readonly controller: MenuController
  readonly surface: SkillagerActionSurface
  readonly children?: ReactNode
}): ReactElement {
  const open = (trigger: HTMLElement, point?: { x: number; y: number }): void =>
    controller.open(metadata, surface, trigger, point)
  return (
    <div
      className="skillager-action-row"
      onContextMenu={(event) => {
        event.preventDefault()
        open(
          (event.target as HTMLElement).closest('button') ??
            event.currentTarget.querySelector('button')!,
          { x: event.clientX, y: event.clientY },
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
        aria-expanded={
          controller.request?.surface === surface &&
          controller.request.metadata === metadata
        }
        onClick={(event) => open(event.currentTarget)}
      >
        ⋯
      </button>
    </div>
  )
}

export function SkillagerActionsMenu({
  controller,
}: {
  readonly controller: MenuController
}): ReactElement | null {
  const { request, current, dismiss, select } = controller
  const menu = useRef<HTMLDivElement>(null)
  const position = useViewportContextMenuPosition(menu, request)
  // Sidebar paging/filtering can remove the originating row without changing the workspace.
  useEffect(() => {
    if (request && !current(request)) dismiss()
  })
  useEffect(() => {
    if (!request) return
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
  }, [request, dismiss])
  if (!request || !current(request)) return null
  return createPortal(
    <div
      ref={menu}
      className="path-copy-menu viewport-context-menu"
      role="menu"
      aria-label={`Skill actions for ${request.metadata.name}`}
      style={position}
    >
      {exposureActions(request.metadata).map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => select(item.action)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
