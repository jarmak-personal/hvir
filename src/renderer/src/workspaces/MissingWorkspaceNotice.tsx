import type { ReactElement } from 'react'

import type { HostPath } from '../../../shared'

export function MissingWorkspaceNotice({
  root,
}: {
  readonly root: HostPath
}): ReactElement {
  return (
    <div className="workspace-missing-notice" role="status">
      <strong>Worktree no longer exists</strong>
      <span className="workspace-missing-path">{root.path}</span>
      <span>Its terminals remain available. Close the workspace tab when finished.</span>
    </div>
  )
}
