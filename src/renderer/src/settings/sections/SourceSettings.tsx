import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ExtensionWorkspaceContext } from '../../../../shared/extensions/contract'
import { localPath } from '../../../../shared/host-path'
import type { ExtensionInstallation } from '../../../../shared/extensions/workbench'
import type {
  ExtensionSourceDeclaration,
  ExtensionSourceGrant,
  ExtensionSourceStatus,
} from '../../../../shared/extensions/source-access'

/** Trusted Settings inspect and manage retained source grants. */
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
      key={JSON.stringify([installation.installationId, source])}
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
  const [statuses, setStatuses] = useState<readonly ExtensionSourceStatus[]>([])
  const [decision, setDecision] = useState<{
    token: string
    grant: ExtensionSourceGrant
  }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const preparation = useRef<{
    active: boolean
    owner: number
    generation: number
    token?: string
  }>({ active: false, owner: 0, generation: 0 })
  const abandonDecision = useCallback((): Promise<void> => {
    const lifetime = preparation.current
    lifetime.generation++
    const token = lifetime.token
    delete lifetime.token
    setDecision(undefined)
    return token ? cancelPrepared(token) : Promise.resolve()
  }, [])
  useEffect(() => {
    const lifetime = preparation.current
    lifetime.active = true
    lifetime.owner++
    return () => {
      lifetime.active = false
      void abandonDecision()
    }
  }, [abandonDecision])
  const isCurrent = (owner: number): boolean =>
    preparation.current.active && preparation.current.owner === owner
  const refresh = async (owner: number): Promise<void> => {
    if (!isCurrent(owner)) return
    const statuses = await window.hvir.invoke('extensions:source-settings', {
      installationId: installation,
    })
    if (!isCurrent(owner)) return
    setStatuses(statuses.sources.filter((entry) => entry.source === source.id))
    setWorkspaces(statuses.workspaces)
  }
  const run = async (operation: (owner: number) => Promise<void>): Promise<void> => {
    const owner = preparation.current.owner
    setBusy(true)
    setError(undefined)
    try {
      await operation(owner)
    } catch (reason) {
      if (isCurrent(owner))
        setError(reason instanceof Error ? reason.message : 'Source setup failed')
    } finally {
      if (isCurrent(owner)) setBusy(false)
    }
  }
  useEffect(() => {
    let current = true
    void window.hvir
      .invoke('extensions:source-settings', { installationId: installation })
      .then(
        (statuses) => {
          if (current) {
            setStatuses(statuses.sources.filter((entry) => entry.source === source.id))
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
  }, [installation, source.id])
  return (
    <fieldset disabled={busy}>
      <legend>
        {source.mode === 'read-only' ? 'Read-only source' : 'Delivery scope'}: {source.id}
      </legend>
      <p>{source.description}</p>
      {statuses.map((status, index) => (
        <div
          key={JSON.stringify([status.workspaceId, status.root, index])}
          className="extension-source-binding"
        >
          <p role="status">
            {status.granted
              ? 'Granted'
              : status.root
                ? 'Saved · unavailable'
                : 'Not granted'}
            {status.root ? ` · ${status.root.hostId}: ${status.root.path}` : ''}
            {status.explanation ? ` · ${status.explanation}` : ''}
          </p>
          {status.root ? (
            <button
              className="hvir-button"
              type="button"
              onClick={() =>
                void run(async (owner) => {
                  await abandonDecision()
                  if (!isCurrent(owner)) return
                  await window.hvir.invoke('extensions:source-revoke', {
                    installationId: installation,
                    source: source.id,
                    ...(status.workspaceId && status.root
                      ? {
                          binding: { workspaceId: status.workspaceId, root: status.root },
                        }
                      : {}),
                  })
                  await refresh(owner)
                })
              }
            >
              {source.mode === 'read-only'
                ? 'Revoke read access'
                : 'Revoke delivery scope'}
            </button>
          ) : null}
        </div>
      ))}
      {source.context === 'application' ? (
        <label>
          Local folder (absolute path)
          <input
            className="hvir-input"
            aria-label={`Source root for ${source.id}`}
            value={path}
            onChange={(event) => {
              setPath(event.target.value)
              void abandonDecision()
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
              void abandonDecision()
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
          void run(async (owner) => {
            const retiring = abandonDecision()
            const generation = preparation.current.generation
            await retiring
            if (!isCurrent(owner) || preparation.current.generation !== generation) return
            const prepared = await window.hvir.invoke('extensions:source-prepare', {
              installationId: installation,
              source: source.id,
              ...(source.context === 'application'
                ? { root: localPath(path) }
                : { workspaceId }),
            })
            if (!isCurrent(owner) || preparation.current.generation !== generation) {
              await cancelPrepared(prepared.token)
              return
            }
            preparation.current.token = prepared.token
            setDecision(prepared)
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
              void run(async (owner) => {
                try {
                  await window.hvir.invoke('extensions:source-approve', {
                    token: decision.token,
                  })
                } finally {
                  if (preparation.current.token === decision.token) {
                    delete preparation.current.token
                    if (isCurrent(owner)) setDecision(undefined)
                  }
                }
                await refresh(owner)
              })
            }
          >
            {source.mode === 'read-only'
              ? 'Grant read-only access'
              : 'Grant delivery scope'}
          </button>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  )
}

function cancelPrepared(token: string): Promise<void> {
  return window.hvir
    .invoke('extensions:source-cancel-prepared', { token })
    .catch(() => {})
}
