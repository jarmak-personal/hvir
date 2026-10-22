import { useState, type ReactElement } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { useExtensionContributions } from './extension-contribution-context'
import { ExtensionProjectPicker } from './ExtensionProjectPicker'

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
    <div className="extension-workspace-target" aria-busy={busy}>
      <ExtensionProjectPicker
        compact
        projects={model?.projects}
        workspaces={model?.workspaces ?? []}
        workspace={view.context?.workspace}
        disabled={busy}
        onChange={(workspaceId) => {
          setBusy(true)
          setError('')
          void window.hvir
            .invoke('extensions:target-view', {
              viewId: view.id,
              workspaceId,
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
      />
      {error ? <span role="status">{error}</span> : null}
    </div>
  )
}
