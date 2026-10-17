import type { ReactElement } from 'react'
import type { SessionsProjectHandle, SessionsWorkspaceProjection } from '../../../shared'

/** Project controls remain available when session grouping is disabled. */
export function SessionsProjectLaunchers({
  workspaces,
  onNew,
}: {
  readonly workspaces: readonly SessionsWorkspaceProjection[]
  readonly onNew: (project: SessionsProjectHandle, name: string) => void
}): ReactElement {
  const projects = [
    ...new Map(workspaces.map((workspace) => [workspace.projectId, workspace])).values(),
  ]
  return (
    <div className="sessions-project-launchers">
      {projects.map((project) => (
        <header className="sessions-project-header" key={project.projectId}>
          <h2>{project.projectName}</h2>
          <button
            type="button"
            onClick={() => onNew(project.projectId, project.projectName)}
            className="hvir-button"
          >
            New session
          </button>
        </header>
      ))}
    </div>
  )
}
