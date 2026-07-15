import { useState, type ReactElement } from 'react'

import {
  displayHostPath,
  type ProjectState,
  type RegisteredProjectState,
  type WorkspaceState,
} from '../../../shared'
import type { TerminalWorkspaceRollup } from '../terminal/TerminalWorkspace'
import { RemoteConnectionBadge } from './ConnectionStatus'
import { aggregateWorkspaceAttention } from './workspace-attention'
import type { AppTheme } from '../theme'

interface ProjectsBarProps {
  readonly state: ProjectState
  readonly rollups: Readonly<Record<string, TerminalWorkspaceRollup>>
  readonly busy: boolean
  readonly onAdd: () => void
  readonly onSwitch: (projectId: string, workspaceId: string) => void
  readonly onRefresh: (projectId: string) => void
  readonly onPrune: (projectId: string) => void
  readonly onDismiss: (projectId: string, workspaceId: string) => void
  readonly theme: AppTheme
  readonly onTheme: (theme: AppTheme) => void
  readonly onSettings: () => void
}

export function ProjectsBar({
  state,
  rollups,
  busy,
  onAdd,
  onSwitch,
  onRefresh,
  onPrune,
  onDismiss,
  theme,
  onTheme,
  onSettings,
}: ProjectsBarProps): ReactElement {
  const [pruneProjectId, setPruneProjectId] = useState<string>()
  const activeProject = state.projects.find(
    (project) => project.id === state.activeProjectId,
  )
  const prunable =
    activeProject?.workspaces.filter(
      (workspace) => workspace.prunableReason !== undefined,
    ) ?? []
  const pruneProject = state.projects.find((project) => project.id === pruneProjectId)
  const pruneTargets =
    pruneProject?.workspaces.filter(
      (workspace) => workspace.prunableReason !== undefined,
    ) ?? []
  return (
    <>
      <header className="projects-shell">
        <nav className="projects-bar" aria-label="Projects">
          {state.projects.map((project) => {
            const changed = project.workspaces
              .filter((workspace) => !workspace.missing)
              .reduce((total, workspace) => total + workspace.changedFiles, 0)
            const unseen = aggregateWorkspaceAttention(
              project.workspaces.map((workspace) => workspace.id),
              rollups,
            ).unseen
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
                <strong>{project.displayName}</strong>
                {project.registeredRoot.hostId !== 'local' ? (
                  <RemoteConnectionBadge
                    state={project.connectionState}
                    hostLabel={`ssh:${project.registeredRoot.hostId}`}
                  />
                ) : null}
                {changed > 0 ? (
                  <span
                    className="project-change-count"
                    aria-label={`${changed} changed files`}
                    title={`${changed} changed files`}
                  >
                    <span aria-hidden="true">Δ </span>
                    {changed}
                  </span>
                ) : null}
                {unseen > 0 ? <AttentionCount count={unseen} /> : null}
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
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>
          </button>
          <button
            type="button"
            className="settings-toggle"
            aria-label="Open settings"
            title="Settings"
            onClick={onSettings}
          >
            <span aria-hidden="true">⚙</span>
          </button>
        </nav>
        {activeProject && activeProject.workspaces.length > 1 ? (
          <nav className="workspaces-bar" aria-label="Worktree workspaces">
            {activeProject.workspaces.map((workspace) => (
              <div
                className={`workspace-tab${workspace.id === state.activeWorkspaceId ? ' active' : ''}${workspace.missing ? ' missing' : ''}`}
                key={workspace.id}
                title={workspaceStatusTitle(workspace)}
              >
                <button
                  type="button"
                  disabled={busy || workspace.missing}
                  onClick={() => onSwitch(activeProject.id, workspace.id)}
                  title={workspaceStatusTitle(workspace)}
                >
                  <span>{workspace.name}</span>
                  {workspace.main ? <small>main checkout</small> : null}
                  {workspace.prunableReason ? <small>prunable</small> : null}
                  {workspace.changedFiles > 0 ? (
                    <b
                      className="workspace-change-count"
                      aria-label={`${workspace.changedFiles} changed files`}
                      title={`${workspace.changedFiles} changed files`}
                    >
                      <span aria-hidden="true">Δ </span>
                      {workspace.changedFiles}
                    </b>
                  ) : null}
                  {(rollups[workspace.id]?.unseen ?? 0) > 0 ? (
                    <AttentionCount count={rollups[workspace.id]?.unseen ?? 0} />
                  ) : null}
                </button>
                {workspace.missing && !workspace.prunableReason ? (
                  <button
                    type="button"
                    className="workspace-dismiss"
                    disabled={busy}
                    onClick={() => onDismiss(activeProject.id, workspace.id)}
                    aria-label={`Dismiss removed workspace ${workspace.name}`}
                    title="Forget removed worktree from hvir"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            <div className="workspaces-actions">
              {prunable.length > 0 ? (
                <button
                  type="button"
                  className="workspaces-prune"
                  disabled={busy || activeProject.connectionState !== 'connected'}
                  onClick={() => setPruneProjectId(activeProject.id)}
                  title="Remove Git's stale worktree administrative records"
                >
                  Prune {prunable.length}
                </button>
              ) : null}
              <button
                type="button"
                className="workspaces-refresh"
                disabled={busy || activeProject.connectionState !== 'connected'}
                onClick={() => onRefresh(activeProject.id)}
              >
                Refresh
              </button>
            </div>
          </nav>
        ) : null}
      </header>
      {pruneProject && pruneTargets.length > 0 ? (
        <PruneWorktreesDialog
          project={pruneProject}
          workspaces={pruneTargets}
          onCancel={() => setPruneProjectId(undefined)}
          onConfirm={() => {
            setPruneProjectId(undefined)
            onPrune(pruneProject.id)
          }}
        />
      ) : null}
    </>
  )
}

function AttentionCount({ count }: { readonly count: number }): ReactElement {
  const label = `${count} unseen terminal${count === 1 ? '' : 's'}`
  return (
    <span className="terminal-attention-count" aria-label={label} title={label}>
      <span aria-hidden="true">!</span>
      {count}
    </span>
  )
}

function PruneWorktreesDialog({
  project,
  workspaces,
  onCancel,
  onConfirm,
}: {
  readonly project: RegisteredProjectState
  readonly workspaces: readonly WorkspaceState[]
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog worktree-prune-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-prune-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2 id="worktree-prune-title">
          Prune {workspaces.length} stale worktree
          {workspaces.length === 1 ? '' : 's'}?
        </h2>
        <p>
          Git will remove stale administrative records from {project.displayName}. It will
          not delete existing worktree directories.
        </p>
        <div className="worktree-prune-list">
          {workspaces.map((workspace) => (
            <div key={workspace.id}>
              <code>{displayHostPath(workspace.root)}</code>
              <small>
                {workspace.prunableReason}
                {workspace.head ? ` · HEAD ${workspace.head.slice(0, 8)}` : ''}
              </small>
            </div>
          ))}
        </div>
        <p className="worktree-prune-warning">
          A detached commit without another reference may eventually become eligible for
          Git garbage collection.
        </p>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            Prune stale records
          </button>
        </div>
      </section>
    </div>
  )
}

function workspaceStatusTitle(workspace: WorkspaceState): string {
  if (workspace.prunableReason) {
    return `${workspace.root.path}\nGit reports this worktree as prunable: ${workspace.prunableReason}`
  }
  if (workspace.missing) {
    return `${workspace.root.path}\nThis worktree was absent from Git's last successful discovery.`
  }
  return workspace.root.path
}

function activeWorkspace(project: RegisteredProjectState) {
  return (
    project.workspaces.find(
      (workspace) => workspace.id === project.activeWorkspaceId && !workspace.missing,
    ) ?? project.workspaces.find((workspace) => !workspace.missing)
  )
}
