import {
  SKILLAGER_AGENTS,
  skillagerAgentLabel,
  type SkillagerAgent,
} from '../../../shared/skillager'
import { useState, type ReactElement } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerProjectSetup({
  controller,
  root,
}: {
  readonly controller: Pick<SkillagerController, 'project' | 'agent' | 'setAgent'>
  readonly root: HostPath
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  if (root.hostId !== 'local') return null
  const project = controller.project
  const status = project.result?.ok ? project.result.value.status : undefined
  const ready = status?.canProceed && status.working === 'present'
  return (
    <div className="skillager-project-setup-scroll">
      <details
        className="skillager-project-setup"
        aria-label="Project skill setup"
        open={expanded || !ready || project.running || Boolean(project.message)}
        onToggle={(event) => {
          if (ready) setExpanded(event.currentTarget.open)
        }}
      >
        <summary>{ready ? 'Project setup…' : 'Set up project skills'}</summary>
        <p>
          {root.path} · {skillagerAgentLabel(controller.agent)}
        </p>
        {status ? (
          <p>
            {setupStatusLabel(status.status)} · {workingLabels[status.working]}
          </p>
        ) : null}
        {
          <>
            <label>
              Setup agent{' '}
              <select
                value={controller.agent}
                disabled={project.starting || project.running}
                onChange={(event) =>
                  controller.setAgent(event.currentTarget.value as SkillagerAgent)
                }
              >
                {SKILLAGER_AGENTS.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Review project skills and include Working in a new interactive terminal.
            </p>
            <button
              type="button"
              disabled={project.starting || project.running || project.loading}
              onClick={() => void project.setup()}
            >
              {project.starting
                ? 'Opening setup terminal…'
                : project.running
                  ? 'Setup terminal running'
                  : 'Set up in terminal'}
            </button>
          </>
        }
        {project.message ? <p role="alert">{project.message}</p> : null}
      </details>
    </div>
  )
}

const workingLabels = {
  missing: 'Working not installed',
  present: 'Working installed',
  unmanaged: 'Working present · unmanaged',
  drift: 'Working customized',
  stale: 'Working needs refresh',
} as const
function setupStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: 'Ready',
    'review-needed': 'Project review needed',
    'lint-blocked': 'Project lint fixes needed',
    'bootstrap-repair': 'Project setup needs repair',
    'migration-needed': 'Project migration needed',
    'manual-repair': 'Manual project repair needed',
  }
  return labels[status] ?? `Skillager status: ${status.replaceAll('-', ' ')}`
}
