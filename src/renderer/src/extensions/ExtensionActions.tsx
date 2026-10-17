import { useState, type ReactElement } from 'react'
import { extensionActionRoutes } from './extension-action-routes'
import { useExtensionContributions } from './extension-contribution-context'

/** Trusted action activation is available in Settings regardless of rail visibility. */
export function ExtensionActions({
  installationId,
}: {
  readonly installationId: string
}): ReactElement | null {
  const model = useExtensionContributions()
  const [contextId, setContextId] = useState<string>()
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const extension = model?.state.find((entry) => entry.installationId === installationId)
  if (!extension?.manifest.actions?.length) return null
  const workspaces =
    model?.workspaces ?? model?.sessions.map((entry) => entry.workspace) ?? []
  const destination =
    contextId ?? (model?.workspaceId ? `workspace:${model.workspaceId}` : '')
  const selected = model?.sessions.find(
    (session) => `session:${session.id}` === destination,
  )
  const workspace =
    selected?.workspace ??
    workspaces.find((entry) => `workspace:${entry.id}` === destination)
  const context = {
    surface: 'viewer' as const,
    ...(workspace ? { workspaceId: workspace.id } : {}),
    ...(selected ? { sessionId: selected.id } : {}),
  }
  const { runnable, taskViews } = extensionActionRoutes(extension.manifest)

  return (
    <div className="extension-actions">
      {runnable.length || taskViews.some((view) => view.placement === 'workspace') ? (
        <label>
          Action context{' '}
          <select
            aria-label="Extension action context"
            value={destination}
            onChange={(event) => setContextId(event.target.value)}
            className="hvir-input"
          >
            <option value="">Application</option>
            {workspaces.map((entry) => (
              <option key={entry.id} value={`workspace:${entry.id}`}>
                {entry.name} · {entry.host}: {entry.root?.path ?? 'Path unavailable'}
              </option>
            ))}
            {model?.sessions.map((session) => (
              <option key={session.id} value={`session:${session.id}`}>
                {session.title} · {session.workspace.host}:{' '}
                {session.workspace.root?.path ?? session.workspace.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {taskViews.map((view) => (
        <button
          key={view.id}
          className="hvir-button"
          type="button"
          disabled={busy || (view.placement === 'workspace' && !workspace)}
          onClick={() => {
            setBusy(true)
            void model
              ?.open(
                installationId,
                view.id,
                view.placement === 'workspace' ? context : { surface: 'viewer' },
              )
              .then(
                () => setStatus(`Opened ${view.title}`),
                (reason: unknown) =>
                  setStatus(
                    reason instanceof Error ? reason.message : 'View unavailable',
                  ),
              )
              .finally(() => setBusy(false))
          }}
        >
          Open {view.title}
        </button>
      ))}
      {runnable.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setStatus('Action running')
            void window.hvir
              .invoke('extensions:action', {
                installationId,
                action: action.id,
                input: null,
                context,
              })
              .then(
                () => setStatus('Action completed'),
                (reason: unknown) =>
                  setStatus(
                    reason instanceof Error ? reason.message : 'Action unavailable',
                  ),
              )
              .finally(() => setBusy(false))
          }}
          className="hvir-button"
        >
          Run {action.title}
        </button>
      ))}
      <span role="status">{status}</span>
    </div>
  )
}
