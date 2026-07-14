import type { ReactElement } from 'react'

import type { ProjectState, RegisteredProjectState } from '../../../shared'
import type { TerminalWorkspaceRollup } from '../terminal/TerminalWorkspace'

interface ProjectsBarProps {
  readonly state: ProjectState
  readonly rollups: Readonly<Record<string, TerminalWorkspaceRollup>>
  readonly busy: boolean
  readonly onAdd: () => void
  readonly onSwitch: (projectId: string, workspaceId: string) => void
  readonly onRefresh: (projectId: string) => void
  readonly onDismiss: (projectId: string, workspaceId: string) => void
}

export function ProjectsBar({
  state,
  rollups,
  busy,
  onAdd,
  onSwitch,
  onRefresh,
  onDismiss,
}: ProjectsBarProps): ReactElement {
  const activeProject = state.projects.find(
    (project) => project.id === state.activeProjectId,
  )
  return (
    <header className="projects-shell">
      <nav className="projects-bar" aria-label="Projects">
        {state.projects.map((project) => {
          const changed = project.workspaces
            .filter((workspace) => !workspace.missing)
            .reduce((total, workspace) => total + workspace.changedFiles, 0)
          const unseen = project.workspaces.reduce(
            (total, workspace) => total + (rollups[workspace.id]?.unseen ?? 0),
            0,
          )
          const target = activeWorkspace(project)
          return (
            <button
              type="button"
              className={`project-tab${project.id === state.activeProjectId ? ' active' : ''}`}
              aria-current={project.id === state.activeProjectId ? 'page' : undefined}
              key={project.id}
              disabled={busy || !target}
              onClick={() => target && onSwitch(project.id, target.id)}
              title={`${project.registeredRoot.path} · ${project.connectionState}`}
            >
              <span className={`connection-state ${project.connectionState}`} />
              <strong>{project.displayName}</strong>
              {project.registeredRoot.hostId !== 'local' ? (
                <small className="project-host-badge">
                  ssh:{project.registeredRoot.hostId}
                </small>
              ) : null}
              {changed > 0 ? (
                <span className="project-change-count">{changed}</span>
              ) : null}
              {unseen > 0 ? (
                <span
                  className="workspace-attention-dot"
                  aria-label="Terminal attention"
                />
              ) : null}
            </button>
          )
        })}
        <button
          type="button"
          className="project-add"
          aria-label="Register project"
          title="Register project"
          disabled={busy}
          onClick={onAdd}
        >
          +
        </button>
      </nav>
      {activeProject && activeProject.workspaces.length > 1 ? (
        <nav className="workspaces-bar" aria-label="Worktree workspaces">
          {activeProject.workspaces.map((workspace) => (
            <div
              className={`workspace-tab${workspace.id === state.activeWorkspaceId ? ' active' : ''}${workspace.missing ? ' missing' : ''}`}
              key={workspace.id}
            >
              <button
                type="button"
                disabled={busy || workspace.missing}
                onClick={() => onSwitch(activeProject.id, workspace.id)}
                title={workspace.root.path}
              >
                <span>{workspace.name}</span>
                {workspace.main ? <small>main checkout</small> : null}
                {workspace.changedFiles > 0 ? <b>{workspace.changedFiles}</b> : null}
                {(rollups[workspace.id]?.unseen ?? 0) > 0 ? (
                  <i
                    className="workspace-attention-dot"
                    aria-label="Terminal attention"
                  />
                ) : null}
              </button>
              {workspace.missing ? (
                <button
                  type="button"
                  className="workspace-dismiss"
                  disabled={busy}
                  onClick={() => onDismiss(activeProject.id, workspace.id)}
                  aria-label={`Dismiss removed workspace ${workspace.name}`}
                  title="Dismiss removed worktree"
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="workspaces-refresh"
            disabled={busy || activeProject.connectionState !== 'connected'}
            onClick={() => onRefresh(activeProject.id)}
          >
            Refresh
          </button>
        </nav>
      ) : null}
    </header>
  )
}

function activeWorkspace(project: RegisteredProjectState) {
  return (
    project.workspaces.find(
      (workspace) => workspace.id === project.activeWorkspaceId && !workspace.missing,
    ) ?? project.workspaces.find((workspace) => !workspace.missing)
  )
}
