import { useId, type ReactElement } from 'react'
import type { RegisteredProjectState } from '../../../shared/workspace-types'
import type { ExtensionWorkspaceContext } from '../../../shared/extensions/contract'

/** Registered hierarchy is shell presentation; the main context owner admits each target. */
export function ExtensionProjectPicker({
  projects = [],
  workspaces,
  workspace,
  disabled,
  compact = false,
  onChange,
}: {
  readonly projects?: readonly RegisteredProjectState[]
  readonly workspaces: readonly ExtensionWorkspaceContext[]
  readonly workspace?: ExtensionWorkspaceContext
  readonly disabled?: boolean
  readonly compact?: boolean
  readonly onChange: (workspaceId?: string) => void
}): ReactElement {
  const locationId = useId()
  const admittedById = new Map(workspaces.map((entry) => [entry.id, entry]))
  const choices = projects.map((project) => ({
    project,
    workspaces: project.workspaces.flatMap((entry) => {
      const admitted = admittedById.get(entry.id)
      return admitted ? [admitted] : []
    }),
  }))
  const selected = choices.find(({ project }) =>
    project.workspaces.some((entry) => entry.id === workspace?.id),
  )
  const location = workspace?.root
    ? `${workspace.root.hostId}: ${workspace.root.path}`
    : workspace
      ? `${workspace.host}: Path unavailable`
      : 'No project selected'
  return (
    <div className="extension-project-picker" data-compact={compact || undefined}>
      <label>
        <span>Project</span>
        <select
          className="hvir-input"
          aria-label="Extension project destination"
          aria-describedby={locationId}
          title={location}
          value={selected?.project.id ?? (workspace ? 'unavailable' : '')}
          disabled={disabled}
          onChange={(event) => {
            const choice = choices.find(
              ({ project }) => project.id === event.target.value,
            )
            const primary = choice?.project.workspaces.find(
              (entry) =>
                entry.main && choice.workspaces.some(({ id }) => id === entry.id),
            )
            onChange(primary?.id ?? choice?.workspaces[0]?.id)
          }}
        >
          <option value="">Choose a project…</option>
          {workspace && !selected ? (
            <option value="unavailable" disabled>
              Unavailable project
            </option>
          ) : null}
          {choices.map(({ project, workspaces }) => {
            const duplicates = projects.filter(
              (entry) => entry.displayName === project.displayName,
            )
            const sameHost = duplicates.filter(
              (entry) => entry.registeredRoot.hostId === project.registeredRoot.hostId,
            )
            const qualifier =
              sameHost.length > 1
                ? `${project.registeredRoot.hostId}: ${project.registeredRoot.path}`
                : duplicates.length > 1 || project.registeredRoot.hostId !== 'local'
                  ? project.registeredRoot.hostId
                  : ''
            return (
              <option key={project.id} value={project.id} disabled={!workspaces.length}>
                {project.displayName}
                {qualifier ? ` · ${qualifier}` : ''}
                {!workspaces.length ? ' · unavailable' : ''}
              </option>
            )
          })}
        </select>
      </label>
      {selected &&
      (selected.workspaces.length > 1 ||
        !selected.workspaces.some(({ id }) => id === workspace?.id)) ? (
        <label>
          <span>Worktree</span>
          <select
            className="hvir-input"
            aria-label="Extension worktree destination"
            aria-describedby={locationId}
            title={location}
            value={workspace?.id ?? ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {workspace && !selected.workspaces.some(({ id }) => id === workspace.id) ? (
              <option value={workspace.id} disabled>
                {workspace.name} · unavailable
              </option>
            ) : null}
            {selected.workspaces.map((entry) => (
              <option
                key={entry.id}
                value={entry.id}
                title={`${entry.host}: ${entry.root?.path ?? 'Path unavailable'}`}
              >
                {entry.name}
                {selected.workspaces.filter(({ name }) => name === entry.name).length > 1
                  ? ` · ${entry.root?.path ?? entry.id}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <span id={locationId} className="extension-workspace-location" title={location}>
        {location}
      </span>
    </div>
  )
}
