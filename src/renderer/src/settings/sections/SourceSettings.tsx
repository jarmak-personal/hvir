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
  const sources = installation.manifest?.access ?? []
  const reading = sources.filter(
    (entry) => entry.context === 'application' && entry.mode === 'read-only',
  )
  const optional = sources.filter((entry) => !reading.includes(entry))
  const setup = (source: ExtensionSourceDeclaration): ReactElement => (
    <SourceSetup
      key={source.id}
      installation={installation.installationId!}
      source={source}
    />
  )
  return (
    <>
      {reading.map(setup)}
      {optional.length ? (
        <details className="extension-optional-setup">
          <summary>Project and delivery access</summary>
          <p>Project reading and delivery have separate scopes.</p>
          {optional.map(setup)}
        </details>
      ) : null}
      {!sources.length ? <p>This extension requests no file access.</p> : null}
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
  const scope =
    source.mode === 'read-only'
      ? 'read-only'
      : source.mode === 'delivery-source'
        ? 'local export capture'
        : 'managed delivery'
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
      <legend>
        {source.mode === 'read-only' ? 'Read-only source' : 'Delivery scope'}: {source.id}
      </legend>
      <p>{source.description}</p>
      <p role="status">
        {status?.granted ? 'Granted' : 'Not granted'}
        {status?.root ? ` · ${status.root.hostId}: ${status.root.path}` : ''}
        {status?.explanation ? ` · ${status.explanation}` : ''}
      </p>
      {source.context === 'application' ? (
        <label>
          Local folder (absolute path)
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
          Project or worktree
          <select
            className="hvir-input"
            aria-label={`Registered workspace for ${source.id}`}
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
              setDecision(undefined)
            }}
          >
            <option value="">Choose a project or worktree</option>
            {workspaces
              .filter(
                (entry) =>
                  entry.root &&
                  (source.mode !== 'managed-delivery' || entry.root.hostId !== 'local'),
              )
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.root!.hostId}: {entry.root!.path}
                </option>
              ))}
          </select>
        </label>
      )}
      <p>
        {source.context === 'application'
          ? 'Choose a local folder, independent of the project you are viewing.'
          : 'Choose one registered project or worktree on its own host. Other projects do not receive this access.'}{' '}
        {source.mode === 'read-only'
          ? 'Allows you to read selected files and images inside this folder. It does not change files or approve a skill. Agents and extension actions cannot read skill instructions.'
          : source.mode === 'delivery-source'
            ? 'Allows complete local exports from this folder for delivery. It does not approve skills or allow instruction reading. Running a command needs separate approval.'
            : 'Allows delivery only to this SSH project. New copies need a destination that does not already exist. Updates and removal need unchanged hvir-owned copies. Replaced files are preserved outside the skill folders.'}
      </p>

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
        {source.mode === 'read-only' ? 'Inspect read access' : 'Inspect delivery scope'}
      </button>
      {decision ? (
        <>
          <p>
            Grant {scope} access to{' '}
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
            {source.mode === 'read-only'
              ? 'Grant read-only access'
              : 'Grant delivery scope'}
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
        {source.mode === 'read-only' ? 'Revoke read access' : 'Revoke delivery scope'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  )
}
