import { useState, type ReactElement } from 'react'
import { useExtensionContributions } from './extension-contribution-context'

/** Trusted action activation is available in Settings regardless of rail visibility. */
export function ExtensionActions({
  installationId,
}: {
  readonly installationId: string
}): ReactElement | null {
  const model = useExtensionContributions()
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const extension = model?.state.find((entry) => entry.installationId === installationId)
  if (!extension?.manifest.actions?.length) return null
  const selected = model?.sessions.find((session) => session.id === sessionId)
  return (
    <div className="extension-actions">
      <label>
        Action context{' '}
        <select
          aria-label="Extension action context"
          value={selected?.id ?? ''}
          onChange={(event) => setSessionId(event.target.value)}
        >
          <option value="">Application</option>
          {model?.sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title}
            </option>
          ))}
        </select>
      </label>
      {extension.manifest.actions.map((action) => (
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
                context: {
                  surface: 'viewer',
                  ...(selected
                    ? { workspaceId: selected.workspace.id, sessionId: selected.id }
                    : {}),
                },
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
        >
          Run {action.title}
        </button>
      ))}
      <span role="status">{status}</span>
    </div>
  )
}
