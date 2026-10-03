import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionWorkspaceContext } from '../../../../shared/extensions/contract'
import { localPath } from '../../../../shared/host-path'
import type { ExtensionInstallation } from '../../../../shared/extensions/workbench'
import type {
  ExtensionSourceDeclaration,
  ExtensionSourceGrant,
  ExtensionSourceStatus,
} from '../../../../shared/extensions/source-access'

/** Read decisions belong to trusted workbench Settings, never to guest claims. */
export function SourceSettings({
  installation,
}: {
  readonly installation: ExtensionInstallation
}): ReactElement | null {
  if (!installation.enabled || !installation.installationId) return null
  return (
    <>
      {installation.manifest?.access.map((source) => (
        <SourceSetup
          key={source.id}
          installation={installation.installationId!}
          source={source}
        />
      ))}
    </>
  )
}
function SourceSetup({
  installation,
  source,
}: {
  readonly installation: string
  readonly source: ExtensionSourceDeclaration
}): ReactElement {
  const [path, setPath] = useState('')
  const [workspaces, setWorkspaces] = useState<readonly ExtensionWorkspaceContext[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [status, setStatus] = useState<ExtensionSourceStatus>()
  const [decision, setDecision] = useState<{
    token: string
    grant: ExtensionSourceGrant
  }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = async (): Promise<void> => {
    const statuses = await window.hvir.invoke('extensions:source-settings', {
      installationId: installation,
    })
    setStatus(statuses.sources.find((entry) => entry.source === source.id))
    setWorkspaces(statuses.workspaces)
  }
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Source setup failed')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let current = true
    void window.hvir
      .invoke('extensions:source-settings', { installationId: installation })
      .then(
        (statuses) => {
          if (current) {
            setStatus(statuses.sources.find((entry) => entry.source === source.id))
            setWorkspaces(statuses.workspaces)
          }
        },
        () => {
          if (current) setError('Source settings are unavailable')
        },
      )
    return () => {
      current = false
    }
  }, [installation, source])
  return (
    <fieldset disabled={busy}>
      <legend>Read-only source: {source.id}</legend>
      <p>{source.description}</p>
      <p>
        {source.context === 'application'
          ? 'An explicitly selected local directory, independent of the selected workspace.'
          : 'One explicitly chosen registered project/worktree on its own host. Other current or future workspaces acquire no scope.'}{' '}
        This grants selected document and confined image reads, never mutation or content
        acceptance. Agent and action callers cannot read instruction bodies.
      </p>
      <p role="status">
        {status?.granted ? 'Granted' : 'Not granted'}
        {status?.root ? ` · ${status.root.hostId}: ${status.root.path}` : ''}
        {status?.explanation ? ` · ${status.explanation}` : ''}
      </p>
      {source.context === 'application' ? (
        <label>
          Absolute local source root
          <input
            className="hvir-input"
            aria-label={`Source root for ${source.id}`}
            value={path}
            onChange={(event) => {
              setPath(event.target.value)
              setDecision(undefined)
            }}
          />
        </label>
      ) : (
        <label>
          Registered workspace
          <select
            aria-label={`Registered workspace for ${source.id}`}
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
              setDecision(undefined)
            }}
          >
            <option value="">Choose a registered workspace</option>
            {workspaces
              .filter((entry) => entry.root)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.root!.hostId}: {entry.root!.path}
                </option>
              ))}
          </select>
        </label>
      )}
      <button
        className="hvir-button"
        type="button"
        onClick={() =>
          void run(async () => {
            setDecision(
              await window.hvir.invoke('extensions:source-prepare', {
                installationId: installation,
                source: source.id,
                ...(source.context === 'application'
                  ? { root: localPath(path) }
                  : { workspaceId }),
              }),
            )
          })
        }
      >
        Inspect read access
      </button>
      {decision ? (
        <>
          <p>
            Grant read-only access to{' '}
            {decision.grant.root
              ? `${decision.grant.root.hostId}: ${decision.grant.root.path}`
              : 'unavailable source scope'}{' '}
            for this source?
          </p>
          <button
            className="hvir-button"
            type="button"
            onClick={() =>
              void run(async () => {
                await window.hvir.invoke('extensions:source-approve', {
                  token: decision.token,
                })
                setDecision(undefined)
                await refresh()
              })
            }
          >
            Grant read-only access
          </button>
        </>
      ) : null}
      <button
        className="hvir-button"
        type="button"
        onClick={() =>
          void run(async () => {
            await window.hvir.invoke('extensions:source-revoke', {
              installationId: installation,
              source: source.id,
            })
            setDecision(undefined)
            await refresh()
          })
        }
      >
        Revoke read access
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  )
}
