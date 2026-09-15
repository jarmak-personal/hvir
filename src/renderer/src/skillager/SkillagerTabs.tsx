import type { ReactElement } from 'react'
import { skillagerAgentLabel } from '../../../shared/skillager'
import {
  closeOnMiddleClick,
  guardMiddleClickClosePointerDown,
} from '../workbench/middle-click-close'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerTabs({
  controller,
}: {
  readonly controller: SkillagerController
}): ReactElement {
  return (
    <>
      {controller.tabs.map((tab) => (
        <div
          key={tab.id}
          className={`viewer-tab skillager-tab${tab.id === controller.activeId ? ' active' : ''}`}
          role="tab"
          aria-selected={tab.id === controller.activeId}
          onMouseDown={guardMiddleClickClosePointerDown}
          onAuxClick={(event) =>
            closeOnMiddleClick(event, () => controller.close(tab.id))
          }
        >
          <button
            type="button"
            className="tab-main"
            title={
              tab.metadata.workspace?.target.path ??
              tab.metadata.routerMembership?.target.path ??
              tab.metadata.projectSkill?.path.path ??
              tab.metadata.id
            }
            onClick={() => controller.activate(tab.id)}
          >
            <span className="tab-name">
              {tab.metadata.name}
              {tab.metadata.workspace
                ? ` · ${skillagerAgentLabel(tab.metadata.workspace.agent)}`
                : tab.metadata.routerMembership
                  ? ' · Router member'
                  : tab.metadata.projectSkill?.agent
                    ? ` · ${skillagerAgentLabel(tab.metadata.projectSkill.agent)}`
                    : ''}
            </span>
          </button>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close skill ${tab.metadata.name}`}
            onClick={() => controller.close(tab.id)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  )
}
