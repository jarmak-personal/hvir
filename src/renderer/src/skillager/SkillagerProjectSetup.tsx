import { skillagerAgentLabel } from '../../../shared/skillager'
import type { ReactElement } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerProjectSetup({
  controller,
  root,
}: {
  readonly controller: Pick<SkillagerController, 'project' | 'connection' | 'agent'>
  readonly root: HostPath
}): ReactElement | null {
  if (root.hostId !== 'local')
    return (
      <p className="skillager-hint">Project setup runs in a local workspace terminal.</p>
    )
  const project = controller.project
  const status = project.result?.ok ? project.result.value.status : undefined
  const ready = status?.canProceed && status.working === 'present'
  return (
    <section className="skillager-project-setup" aria-label="Project skill setup">
      <strong>{ready ? 'Project setup ready' : 'Set up project skills'}</strong>
      <p>
        {root.path} · {skillagerAgentLabel(controller.agent)}
      </p>
      {status ? (
        <p>
          {setupStatusLabel(status.status)} · {workingLabels[status.working]}
        </p>
      ) : null}
      {!ready ? (
        <>
          <p>Review project skills and include Working in a new interactive terminal.</p>
          <code>
            {controller.connection?.executable.path} setup --agent {controller.agent}
          </code>
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
      ) : null}
      {project.message ? <p role="alert">{project.message}</p> : null}
    </section>
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
