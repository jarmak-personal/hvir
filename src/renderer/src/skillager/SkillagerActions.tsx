import { useEffect, type ReactElement, type ReactNode } from 'react'
import type { SkillagerMetadata } from '../../../shared/skillager'
import { SkillagerMenu } from './SkillagerMenu'
import { isNativeProjectSkill } from './skillager-model'
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
  if (
    isNativeProjectSkill(metadata) ||
    exposureActions(metadata).every((action) => action.disabled)
  )
    return <>{children}</>
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
  // Sidebar paging/filtering can remove the originating row without changing the workspace.
  useEffect(() => {
    if (request && !current(request)) dismiss()
  })
  if (!request || !current(request)) return null
  return (
    <SkillagerMenu
      anchor={request}
      label={`Skill actions for ${request.metadata.name}`}
      dismiss={dismiss}
      items={exposureActions(request.metadata).map((item) => ({
        id: item.action,
        label: item.label,
        disabled: item.disabled,
        select: () => select(item.action),
      }))}
    />
  )
}
