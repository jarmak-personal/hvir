import type { ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import type { GitRailModel } from './git-rail-model'
import type { gitRailSyncState } from './git-rail-model'

interface GitBranchControlsProps {
  readonly root: HostPath
  readonly model: GitRailModel
  readonly syncState: ReturnType<typeof gitRailSyncState>
  readonly onSwitchBranch: (branch: string) => void
  readonly onFetch: () => void
  readonly onPull: () => void
}

export function GitBranchControls({
  root,
  model,
  syncState,
  onSwitchBranch,
  onFetch,
  onPull,
}: GitBranchControlsProps): ReactElement | null {
  const {
    branchModel,
    branchError,
    branchSwitching,
    syncBusy,
    syncError,
    lastFetchedAt,
  } = model
  const {
    branchBlockReason,
    hasAlternativeBranch,
    pullBlockReason,
    fetchBlockedReason,
    upstreamSummary,
    baseDrift,
  } = syncState
  if (branchModel?.repositoryState === 'not-git' && !branchError) return null

  return (
    <div className="git-branch-control">
      <label htmlFor="git-branch-select">Branch</label>
      <select
        id="git-branch-select"
        value={branchModel?.current ?? '__detached__'}
        disabled={
          !branchModel ||
          branchSwitching ||
          Boolean(syncBusy) ||
          !hasAlternativeBranch
        }
        title={branchError ?? branchBlockReason ?? 'Switch existing local branch'}
        onChange={(event) => {
          const branch = event.currentTarget.value
          if (branchModel?.branches.some((candidate) => candidate.name === branch)) {
            onSwitchBranch(branch)
          }
        }}
      >
        {!branchModel?.current ? (
          <option value="__detached__" disabled>
            {branchModel?.detached && branchModel.head
              ? `Detached at ${branchModel.head.slice(0, 8)}`
              : 'No branch'}
          </option>
        ) : null}
        {branchModel?.branches.map((branch) => {
          const occupiedElsewhere =
            branch.worktree &&
            (branch.worktree.hostId !== root.hostId || branch.worktree.path !== root.path)
          return (
            <option
              key={branch.name}
              value={branch.name}
              disabled={Boolean(
                occupiedElsewhere || (!branch.current && branchBlockReason),
              )}
            >
              {branch.name}
              {occupiedElsewhere ? ` — in ${branch.worktree?.path}` : ''}
            </option>
          )
        })}
      </select>
      <div className="git-sync-row">
        <div className="git-sync-summary" aria-live="polite">
          <span>{upstreamSummary}</span>
          {baseDrift ? <span className="needs-agent">{baseDrift}</span> : null}
        </div>
        <div className="git-sync-actions">
          <button
            type="button"
            disabled={Boolean(fetchBlockedReason || syncBusy || branchSwitching)}
            title={fetchBlockedReason ?? 'Refresh remote branch information'}
            onClick={onFetch}
          >
            Fetch
          </button>
          <button
            type="button"
            disabled={Boolean(pullBlockReason || syncBusy || branchSwitching)}
            title={pullBlockReason ?? 'Fast-forward from the configured upstream'}
            onClick={onPull}
          >
            Pull
          </button>
        </div>
      </div>
      {syncBusy ? (
        <small>{syncBusy === 'fetch' ? 'Fetching…' : 'Pulling…'}</small>
      ) : syncError ? (
        <small className="error">{syncError}</small>
      ) : lastFetchedAt ? (
        <small title={new Date(lastFetchedAt).toLocaleString()}>
          Remote checked just now
        </small>
      ) : null}
      {branchSwitching ? (
        <small>Switching…</small>
      ) : branchError ? (
        <small className="error">{branchError}</small>
      ) : branchBlockReason && branchModel ? (
        <small>{branchBlockReason}</small>
      ) : null}
    </div>
  )
}
