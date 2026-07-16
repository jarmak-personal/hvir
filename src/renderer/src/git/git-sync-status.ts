import type { GitBranchModel, GitChanges, HostConnectionState } from '../../../shared'

export function gitUpstreamSummary(model: GitBranchModel | undefined): string {
  if (!model) return 'Checking remote status…'
  if (model.repositoryState === 'not-git') return 'Not a Git repository'
  if (!model.current) return model.detached ? 'Detached HEAD' : 'No branch yet'
  if (!model.remoteAvailable) return 'No Git remote configured'
  const upstream = model.sync?.upstream
  if (!upstream) return 'No upstream configured'
  if (upstream.gone) return `${upstream.name} · upstream missing · needs agent`
  if (upstream.ahead > 0 && upstream.behind > 0) {
    return `${upstream.name} · ↑${upstream.ahead} ↓${upstream.behind} · needs agent`
  }
  if (upstream.behind > 0) return `${upstream.name} · ↓${upstream.behind} incoming`
  if (upstream.ahead > 0) return `${upstream.name} · ↑${upstream.ahead} outgoing`
  return `${upstream.name} · up to date`
}

export function gitBaseDriftSummary(
  model: GitBranchModel | undefined,
): string | undefined {
  const base = model?.sync?.base
  if (!model?.current || !base || model.current === base.name || base.behind === 0) {
    return undefined
  }
  return `${base.name} has ${base.behind} newer commit${base.behind === 1 ? '' : 's'} · ask agent to update`
}

export function gitPullBlockReason({
  model,
  changes,
  connectionState,
  hasDirtyViewerTabs,
}: {
  readonly model: GitBranchModel | undefined
  readonly changes: GitChanges | undefined
  readonly connectionState: HostConnectionState
  readonly hasDirtyViewerTabs: boolean
}): string | undefined {
  if (connectionState !== 'connected') return 'Reconnect before pulling'
  if (!model) return 'Checking remote status…'
  if (model.repositoryState !== 'ready') return 'Pull requires an existing branch'
  if (!model.current) return 'Detached HEAD requires an agent'
  if (!model.remoteAvailable) return 'No Git remote is configured'
  const upstream = model.sync?.upstream
  if (!upstream) return 'Configure an upstream through an agent first'
  if (upstream.gone) return 'Missing upstream requires an agent'
  if (hasDirtyViewerTabs) return 'Save or close unsaved viewer tabs before pulling'
  if (!changes) return 'Checking working tree…'
  if (changes.workingTree.length > 0) {
    return 'Working tree changes require an agent before pulling'
  }
  if (upstream.ahead > 0 && upstream.behind > 0) {
    return 'Diverged branch requires an agent'
  }
  if (upstream.behind === 0) return 'No incoming commits'
  return undefined
}
