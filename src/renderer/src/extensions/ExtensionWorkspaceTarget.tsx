import { useState, type ReactElement } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { useExtensionContributions } from './extension-contribution-context'

/** Only the trusted shell sees the catalog; a guest receives one explicit destination. */
export function ExtensionWorkspaceTarget({
  view,
}: {
  readonly view: ExtensionView
}): ReactElement | null {
  const model = useExtensionContributions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const contribution = model?.state
    .find((entry) => entry.installationId === view.installationId)
    ?.manifest.views.find((entry) => entry.id === view.contributionId)
  if (!view.canChooseWorkspace || contribution?.placement !== 'application') return null
  return (
    <label className="extension-workspace-target">
      <span>Project</span>
      <select
        className="hvir-input"
        aria-label="Extension project destination"
        value={view.context?.workspace?.id ?? ''}
        disabled={busy}
        onChange={(event) => {
          setBusy(true)
          setError('')
          void window.hvir
            .invoke('extensions:target-view', {
              viewId: view.id,
              workspaceId: event.target.value || undefined,
            })
            .catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Project selection is unavailable',
              ),
            )
            .finally(() => setBusy(false))
        }}
      >
        <option value="">Choose a project…</option>
        {model?.workspaces?.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.id === model.workspaceId ? 'Current · ' : ''}
            {workspace.name} · {workspace.host}:{' '}
            {workspace.root?.path ?? 'Path unavailable'}
          </option>
        ))}
      </select>
      {error ? <span role="status">{error}</span> : null}
    </label>
  )
}
