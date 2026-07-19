import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  displayHostPath,
  GIT_CHANGE_DISPLAY_LIMIT,
  type ProjectState,
  type RegisteredProjectState,
  type HostWatchTier,
  type WorkspaceState,
} from '../../../shared'
import { RemoteConnectionBadge } from './ConnectionStatus'
import { connectionStateLabel } from './connection-status'
import type { WorkspaceAttentionRollups } from './project-session-model'
import { aggregateWorkspaceAttention } from './workspace-attention'
import type { AppTheme } from '../theme'

interface ProjectsBarProps {
  readonly state: ProjectState
  readonly rollups: WorkspaceAttentionRollups
  readonly busy: boolean
  readonly onAdd: () => void
  readonly onSwitch: (projectId: string, workspaceId: string) => void
  readonly onRefresh: (projectId: string) => void
  readonly onCloseProject: (projectId: string) => void
  readonly onPrune: (projectId: string) => void
  readonly onDismiss: (projectId: string, workspaceId: string) => void
  readonly watchTier: HostWatchTier
  readonly statusError?: string
  readonly onChangeConnection: () => void
  readonly onDisconnect: () => void
  readonly onReconnect: () => void
  readonly theme: AppTheme
  readonly onTheme: (theme: AppTheme) => void
  readonly onSettings: () => void
}

function changeCountLabel(count: number): string {
  return count > GIT_CHANGE_DISPLAY_LIMIT
    ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
    : count.toLocaleString()
}

function projectChangeCountLabel(workspaces: readonly WorkspaceState[]): string {
  const counts = workspaces.map((workspace) => workspace.changedFiles)
  const total = counts.reduce((sum, count) => sum + count, 0)
  const limited = counts.filter((count) => count > GIT_CHANGE_DISPLAY_LIMIT).length
  return limited > 0 ? `${(total - limited).toLocaleString()}+` : total.toLocaleString()
}

export function ProjectsBar({
  state,
  rollups,
  busy,
  onAdd,
  onSwitch,
  onRefresh,
  onCloseProject,
  onPrune,
  onDismiss,
  watchTier,
  statusError,
  onChangeConnection,
  onDisconnect,
  onReconnect,
  theme,
  onTheme,
  onSettings,
}: ProjectsBarProps): ReactElement {
  const [pruneProjectId, setPruneProjectId] = useState<string>()
  const [closeProjectId, setCloseProjectId] = useState<string>()
  const [connectionMenu, setConnectionMenu] = useState<{
    readonly projectId: string
    readonly left: number
    readonly top: number
  }>()
  const connectionMenuRef = useRef<HTMLElement>(null)
  const activeProject = state.projects.find(
    (project) => project.id === state.activeProjectId,
  )
  const prunable =
    activeProject?.workspaces.filter(
      (workspace) => workspace.prunableReason !== undefined,
    ) ?? []
  // A single-checkout project has nothing to switch between; reclaim the row.
  // Errors and prune prompts still force the bar because it is their only home.
  const showWorkspacesBar =
    activeProject !== undefined &&
    (activeProject.workspaces.length > 1 ||
      Boolean(statusError) ||
      prunable.length > 0)
  const pruneProject = state.projects.find((project) => project.id === pruneProjectId)
  const closeProject = state.projects.find((project) => project.id === closeProjectId)
  const pruneTargets =
    pruneProject?.workspaces.filter(
      (workspace) => workspace.prunableReason !== undefined,
    ) ?? []
  const connectionProject =
    activeProject?.id === connectionMenu?.projectId ? activeProject : undefined
  useEffect(() => {
    setConnectionMenu((current) =>
      current && current.projectId !== state.activeProjectId ? undefined : current,
    )
  }, [state.activeProjectId])
  useEffect(() => {
    if (!connectionMenu) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConnectionMenu(undefined)
    }
    window.addEventListener('keydown', handleKeyDown)
    connectionMenuRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [connectionMenu])
  return (
    <>
      <header className="projects-shell">
        <nav className="projects-bar" aria-label="Projects">
          {state.projects.map((project) => {
            const active = project.id === state.activeProjectId
            const remote = project.registeredRoot.hostId !== 'local'
            const presentWorkspaces = project.workspaces.filter(
              (workspace) => !workspace.missing,
            )
            const changed = presentWorkspaces.reduce(
              (total, workspace) => total + workspace.changedFiles,
              0,
            )
            const changedLabel = projectChangeCountLabel(presentWorkspaces)
            const unseen = aggregateWorkspaceAttention(
              project.workspaces.map((workspace) => workspace.id),
              rollups,
            ).unseen
            const target = activeWorkspace(project)
            return (
              <div
                className={`project-tab${active ? ' active' : ''}`}
                key={project.id}
                title={`${project.registeredRoot.path} · ${project.connectionState}`}
              >
                <button
                  type="button"
                  className="project-tab-main"
                  aria-current={active ? 'page' : undefined}
                  disabled={busy || !target}
                  onClick={() => target && onSwitch(project.id, target.id)}
                  title={`${project.registeredRoot.path} · ${project.connectionState}`}
                >
                  <strong>{project.displayName}</strong>
                  {remote && !active ? (
                    <RemoteConnectionBadge
                      state={project.connectionState}
                      hostLabel={`ssh:${project.registeredRoot.hostId}`}
                    />
                  ) : null}
                  {changed > 0 ? (
                    <span
                      className="project-change-count"
                      aria-label={`${changedLabel} changed files`}
                      title={`${changedLabel} changed files`}
                    >
                      <span aria-hidden="true">Δ </span>
                      {changedLabel}
                    </span>
                  ) : null}
                  {unseen > 0 ? <AttentionCount count={unseen} /> : null}
                </button>
                {remote && active ? (
                  <button
                    type="button"
                    className="project-connection-trigger"
                    disabled={busy}
                    aria-haspopup="dialog"
                    aria-expanded={connectionMenu?.projectId === project.id}
                    aria-label={`Connection controls for ssh:${project.registeredRoot.hostId}`}
                    title="Connection controls"
                    onClick={(event) => {
                      if (connectionMenu?.projectId === project.id) {
                        setConnectionMenu(undefined)
                        return
                      }
                      const bounds = event.currentTarget.getBoundingClientRect()
                      setConnectionMenu({
                        projectId: project.id,
                        left: Math.max(8, Math.min(bounds.left, window.innerWidth - 248)),
                        top: bounds.bottom + 4,
                      })
                    }}
                  >
                    <RemoteConnectionBadge
                      state={project.connectionState}
                      hostLabel={`ssh:${project.registeredRoot.hostId}`}
                    />
                    <span className="project-connection-chevron" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="project-close"
                  disabled={busy || state.projects.length <= 1}
                  onClick={() => setCloseProjectId(project.id)}
                  aria-label={`Close project ${project.displayName}`}
                  title={
                    state.projects.length <= 1
                      ? 'Register another project before closing this one'
                      : `Close project ${project.displayName}`
                  }
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
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
          <span className="projects-bar-spacer" />
        </nav>
        {activeProject && showWorkspacesBar ? (
          <nav className="workspaces-bar" aria-label="Workspaces">
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
                  {workspace.main ? <small>project root</small> : null}
                  {workspace.prunableReason ? <small>prunable</small> : null}
                  {workspace.changedFiles > 0 ? (
                    <b
                      className="workspace-change-count"
                      aria-label={`${changeCountLabel(workspace.changedFiles)} changed files`}
                      title={`${changeCountLabel(workspace.changedFiles)} changed files`}
                    >
                      <span aria-hidden="true">Δ </span>
                      {changeCountLabel(workspace.changedFiles)}
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
              {statusError ? (
                <span className="workspace-status-error" title={statusError}>
                  {statusError}
                </span>
              ) : null}
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
      {connectionProject ? (
        <>
          <div
            className="project-connection-backdrop"
            aria-hidden="true"
            onMouseDown={() => setConnectionMenu(undefined)}
          />
          <section
            ref={connectionMenuRef}
            className="project-connection-menu"
            role="dialog"
            aria-modal="true"
            aria-label={`Connection controls for ssh:${connectionProject.registeredRoot.hostId}`}
            tabIndex={-1}
            style={{ left: connectionMenu?.left, top: connectionMenu?.top }}
          >
            <header>
              <strong>ssh:{connectionProject.registeredRoot.hostId}</strong>
              <span>{connectionStateLabel(connectionProject.connectionState)}</span>
            </header>
            <small>{watchTierLabel(watchTier)}</small>
            {statusError ? <p className="error">{statusError}</p> : null}
            <div className="project-connection-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConnectionMenu(undefined)
                  onChangeConnection()
                }}
              >
                Change
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  (connectionProject.connectionState !== 'connected' &&
                    connectionProject.connectionState !== 'disconnected' &&
                    connectionProject.connectionState !== 'failed')
                }
                onClick={() => {
                  setConnectionMenu(undefined)
                  if (
                    connectionProject.connectionState === 'disconnected' ||
                    connectionProject.connectionState === 'failed'
                  ) {
                    onReconnect()
                  } else {
                    onDisconnect()
                  }
                }}
              >
                {busy
                  ? 'Working…'
                  : connectionProject.connectionState === 'disconnected' ||
                      connectionProject.connectionState === 'failed'
                    ? 'Reconnect'
                    : 'Disconnect'}
              </button>
            </div>
          </section>
        </>
      ) : null}
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
      {closeProject ? (
        <CloseProjectDialog
          project={closeProject}
          onCancel={() => setCloseProjectId(undefined)}
          onConfirm={() => {
            setCloseProjectId(undefined)
            onCloseProject(closeProject.id)
          }}
        />
      ) : null}
    </>
  )
}

function CloseProjectDialog({
  project,
  onCancel,
  onConfirm,
}: {
  readonly project: RegisteredProjectState
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog close-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-project-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2 id="close-project-title">Close {project.displayName}?</h2>
        <p>
          This removes the project from hvir and closes its live terminals. Files, Git
          branches, and worktrees are not changed.
        </p>
        <code>{displayHostPath(project.registeredRoot)}</code>
        <p className="dialog-note">
          Terminal recovery metadata is retained, so re-registering this project can
          restore its sessions.
        </p>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            Close project
          </button>
        </div>
      </section>
    </div>
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

function watchTierLabel(watchTier: HostWatchTier): string {
  if (watchTier === 'inotify') return 'File watching: inotify'
  if (watchTier === 'native') return 'File watching: native'
  return 'File watching: polling'
}

function activeWorkspace(project: RegisteredProjectState) {
  return (
    project.workspaces.find(
      (workspace) => workspace.id === project.activeWorkspaceId && !workspace.missing,
    ) ?? project.workspaces.find((workspace) => !workspace.missing)
  )
}
