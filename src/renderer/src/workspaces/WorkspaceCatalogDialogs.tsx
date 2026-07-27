import type { ReactElement } from 'react'

import {
  displayHostPath,
  type RegisteredProjectState,
  type WorkspaceClosePlan,
  type WorkspaceState,
} from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

export function CloseWorkspaceDialog({
  workspace,
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly workspace: WorkspaceState
  readonly plan: WorkspaceClosePlan
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const count = plan.terminalCount
  return (
    <ConfirmationDialog
      labelledBy="close-workspace-title"
      actions={[
        { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
        { label: 'Close workspace', kind: 'destructive', onSelect: onConfirm },
      ]}
      busy={busy}
      className="close-workspace-dialog"
    >
      <h2 id="close-workspace-title">Close {workspace.name}?</h2>
      <p>
        {count} hvir terminal{count === 1 ? '' : 's'} will be terminated. hvir will forget{' '}
        {count === 1 ? 'its' : 'their'} recovery records.
      </p>
      <code>{displayHostPath(workspace.root)}</code>
      <p className="dialog-note">
        Files, Git state, viewer tabs, layouts, and provider-owned conversations are not
        changed.
      </p>
    </ConfirmationDialog>
  )
}

export function ClosedWorktreesDialog({
  project,
  workspaces,
  busy,
  onCancel,
  onReopen,
  onDismiss,
}: {
  readonly project: RegisteredProjectState
  readonly workspaces: readonly WorkspaceState[]
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onReopen: (workspaceId: string) => void
  readonly onDismiss: (workspaceId: string) => void
}): ReactElement {
  return (
    <ConfirmationDialog
      labelledBy="closed-worktrees-title"
      actions={[{ label: 'Close', kind: 'cancel', onSelect: onCancel }]}
      busy={busy}
      className="closed-worktrees-dialog"
    >
      <h2 id="closed-worktrees-title">Closed worktrees in {project.displayName}</h2>
      <p>Reopen a present worktree or manage a worktree that Git no longer finds.</p>
      <div className="closed-worktrees-list">
        {workspaces.map((workspace) => (
          <div className="closed-worktree-row" key={workspace.id}>
            <span>
              <strong>{workspace.name}</strong>
              <code>{displayHostPath(workspace.root)}</code>
              <small>{closedWorktreeState(workspace)}</small>
            </span>
            {!workspace.missing ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onReopen(workspace.id)}
                aria-label={`Reopen workspace ${workspace.name}`}
                title={`Reopen workspace ${workspace.name}`}
              >
                Reopen
              </button>
            ) : !workspace.prunableReason ? (
              <button
                type="button"
                className="destructive"
                disabled={busy}
                onClick={() => onDismiss(workspace.id)}
                aria-label={`Dismiss removed workspace ${workspace.name}`}
                title="Forget removed worktree from hvir"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {workspaces.some((workspace) => workspace.prunableReason) ? (
        <p className="dialog-note">
          Use the existing Prune action to remove Git's stale administrative records.
        </p>
      ) : null}
    </ConfirmationDialog>
  )
}

function closedWorktreeState(workspace: WorkspaceState): string {
  if (workspace.prunableReason) return `Prunable · ${workspace.prunableReason}`
  if (workspace.missing) return 'Missing from the last successful Git discovery'
  return 'Present'
}
