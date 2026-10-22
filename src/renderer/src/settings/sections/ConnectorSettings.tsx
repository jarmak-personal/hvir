import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ProjectHostOption } from '../../../../shared'
import type { ExtensionInstallation } from '../../../../shared/extensions/workbench'
import type {
  ExtensionConnectorApproval,
  ExtensionConnectorDeclaration,
  ExtensionConnectorSetting,
} from '../../../../shared/extensions/connectors'

/** Trusted native approval controls. No executable probe runs before approval. */
export function ConnectorSettings({
  installation,
}: {
  readonly installation: ExtensionInstallation
}): ReactElement | null {
  if (!installation.enabled || !installation.installationId) return null
  const connectors = installation.manifest?.connectors ?? []
  const application = connectors.filter((entry) => entry.context === 'application')
  const project = connectors.filter((entry) => entry.context !== 'application')
  const setup = (connector: ExtensionConnectorDeclaration): ReactElement => (
    <ConnectorSetup
      key={connector.id}
      installation={installation.installationId!}
      connector={connector}
    />
  )
  return (
    <>
      {application.map(setup)}
      {project.length ? (
        <details className="extension-optional-setup">
          <summary>Project program access</summary>
          <p>Configure these separately for project observations or actions.</p>
          {project.map(setup)}
        </details>
      ) : null}
      {!connectors.length ? <p>This extension requests no program access.</p> : null}
    </>
  )
}
function ConnectorSetup({
  installation,
  connector,
}: {
  readonly installation: string
  readonly connector: ExtensionConnectorDeclaration
}): ReactElement {
  const canConnect = connector.context === 'application' && !!connector.setup
  // Republished equal declarations retain setup; authority uses this same exact identity.
  const declarationKey = JSON.stringify(connector)
  const connectionRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!canConnect) return
    const cancel = (): void => {
      const request = connectionRequest.current
      connectionRequest.current = undefined
      if (request)
        void window.hvir
          .invoke('extensions:connection-cancel', { request })
          .catch(() => {})
    }
    return () => cancel()
  }, [canConnect, installation, declarationKey])
  const [checking, setChecking] = useState(true)
  const [inspectionFailed, setInspectionFailed] = useState(false)
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [host, setHost] = useState('local')
  const [path, setPath] = useState('')
  const [configuration, setConfiguration] = useState('{"args":[],"env":{}}')
  const [decision, setDecision] = useState<{
    token: string
    approval: ExtensionConnectorApproval
    trustUpdates: boolean
    preservesBaseline: boolean
  }>()
  const preparation = useRef<{
    active: boolean
    owner: number
    generation: number
    token?: string
  }>({
    active: true,
    owner: 0,
    generation: 0,
  })
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
    setBusy(false)
    setError(undefined)
    setBindings([])
    setHosts([])
    setHost('local')
    setPath('')
    setConfiguration('{"args":[],"env":{}}')
    return () => {
      lifetime.active = false
      void abandonDecision()
    }
  }, [installation, declarationKey, abandonDecision])
  const [bindings, setBindings] = useState<readonly ExtensionConnectorSetting[]>([])
  const status = bindings.find((entry) => entry.host === host)
  const hostLabel = hosts.find((entry) => entry.hostId === host)?.label ?? host
  const selectHost = (selected: string, saved = bindings): void => {
    const binding = saved.find((entry) => entry.host === selected)
    if (selected !== host) {
      setChecking(true)
      setInspectionFailed(false)
    }
    setHost(selected)
    setPath(binding?.selectedExecutable ?? '')
    setConfiguration(JSON.stringify(binding?.configuration ?? { args: [], env: {} }))
    void abandonDecision()
  }
  const isCurrentOwner = (owner: number): boolean =>
    preparation.current.active && preparation.current.owner === owner
  const refresh = async (owner: number): Promise<void> => {
    if (!isCurrentOwner(owner)) return
    const value = await window.hvir.invoke('extensions:connector-settings', {
      installationId: installation,
      connector: connector.id,
      host,
    })
    if (!isCurrentOwner(owner)) return
    const saved = value.connectors.filter((entry) => entry.connector === connector.id)
    setHosts(value.hosts)
    if (value.explanation) setError(value.explanation)
    setBindings(saved)
    selectHost(host, saved)
  }
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (operation: (owner: number) => Promise<void>): Promise<void> => {
    const owner = preparation.current.owner
    setBusy(true)
    setError(undefined)
    try {
      await operation(owner)
    } catch (reason) {
      if (isCurrentOwner(owner))
        setError(reason instanceof Error ? reason.message : 'Native setup failed')
    } finally {
      if (isCurrentOwner(owner)) setBusy(false)
    }
  }
  const prepareDecision = async (trustUpdates: boolean): Promise<void> => {
    const abandoned = abandonDecision()
    const generation = preparation.current.generation
    await abandoned
    if (!preparation.current.active || preparation.current.generation !== generation)
      return
    const prepared = await window.hvir.invoke('extensions:connector-prepare', {
      installationId: installation,
      connector: connector.id,
      host,
      executable: path,
      trustUpdates,
      configuration: JSON.parse(
        configuration,
      ) as ExtensionConnectorApproval['configuration'],
    })
    if (!preparation.current.active || preparation.current.generation !== generation) {
      await cancelPrepared(prepared.token)
      return
    }
    preparation.current.token = prepared.token
    setDecision(prepared)
  }
  useEffect(() => {
    let current = true
    setChecking(true)
    setInspectionFailed(false)
    const generation = preparation.current.generation
    void window.hvir
      .invoke('extensions:connector-settings', {
        installationId: installation,
        connector: connector.id,
        host,
      })
      .then(
        (value) => {
          if (current) {
            setChecking(false)
            setHosts(value.hosts)
            setError(value.explanation)
            const saved = value.connectors.filter(
              (entry) => entry.connector === connector.id,
            )
            setBindings(saved)
            if (preparation.current.generation === generation) {
              const local = saved.find((entry) => entry.host === host)
              setPath(local?.selectedExecutable ?? '')
              setConfiguration(
                JSON.stringify(local?.configuration ?? { args: [], env: {} }),
              )
            }
          }
        },
        () => {
          if (current) {
            setChecking(false)
            setInspectionFailed(true)
            setError('Native settings are unavailable')
          }
        },
      )
    return () => {
      current = false
    }
  }, [installation, connector.id, declarationKey, host])
  return (
    <fieldset disabled={busy}>
      <legend>Program access: {connector.id}</legend>
      <p>{connector.description}</p>
      <p role="status">
        {busy
          ? 'Updating program access…'
          : checking
            ? 'Checking program…'
            : inspectionFailed
              ? 'Couldn’t check program'
              : status?.reason === 'executable-changed'
                ? 'Program updated · review access'
                : status?.availability === 'supported'
                  ? status.trustUpdates
                    ? 'Updates trusted for this session'
                    : 'Approved'
                  : status?.availability === 'disconnected'
                    ? 'Host disconnected'
                    : status?.reason === 'unavailable'
                      ? 'Program unavailable'
                      : `Not approved for ${hostLabel}`}
        {status?.explanation ? ` · ${status.explanation}` : ''}
      </p>
      {bindings.length ? (
        <ul
          className="connector-saved-hosts"
          aria-label={`Saved hosts for ${connector.id}`}
        >
          {bindings.map((binding) => (
            <li key={binding.host}>
              <button
                type="button"
                className="connector-saved-host hvir-focus"
                aria-pressed={host === binding.host}
                onClick={() => selectHost(binding.host)}
              >
                <span>
                  {hosts.find((entry) => entry.hostId === binding.host)?.label ??
                    binding.host}
                </span>
                <span className="connector-host-status">
                  {binding.host === host && checking
                    ? 'Checking…'
                    : binding.host === host && inspectionFailed
                      ? 'Unavailable'
                      : binding.reason === 'unavailable'
                        ? 'Unavailable'
                        : binding.reason === 'executable-changed'
                          ? 'Review update'
                          : binding.availability === 'supported'
                            ? 'Approved'
                            : binding.availability === 'disconnected'
                              ? 'Disconnected'
                              : 'Needs approval'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canConnect && connector.setup ? (
        <button
          type="button"
          className="hvir-button"
          onClick={() =>
            void run(async (owner) => {
              const request = crypto.randomUUID()
              connectionRequest.current = request
              const result = await window.hvir.invoke('extensions:connector-connect', {
                request,
                installationId: installation,
                connector: connector.id,
              })
              if (!isCurrentOwner(owner) || connectionRequest.current !== request) return
              connectionRequest.current = undefined
              const outcome = result.connections.find(
                (entry) => entry.connector === connector.id,
              )
              if (outcome?.outcome === 'interrupted-uncertain')
                setError(outcome.explanation)
              else if (outcome?.outcome !== 'connected')
                setError(
                  outcome?.explanation ?? 'Not connected. Choose Connect when ready.',
                )
              await refresh(owner)
            })
          }
        >
          Connect {connector.setup.executable}
        </button>
      ) : null}
      {connector.context === 'workspace' && connector.setup ? (
        <p>
          Connect {connector.setup.executable} from an open local project view, or
          configure program access here.
        </p>
      ) : null}
      <details open={!canConnect || status?.reason === 'executable-changed'}>
        <summary>Manual program configuration</summary>
        {status?.executable ? (
          <details>
            <summary>Program targets</summary>
            <p>
              Approved: {status.host}: {status.executable}
            </p>
            {status.currentExecutable ? (
              <p>
                Current: {status.host}: {status.currentExecutable}
              </p>
            ) : null}
          </details>
        ) : null}
        <label>
          Host
          <select
            aria-label={`Host for ${connector.id}`}
            value={host}
            onChange={(event) => {
              selectHost(event.target.value)
            }}
            className="hvir-input"
          >
            {!hosts.some((entry) => entry.hostId === host) ? (
              <option value={host}>{hostLabel}</option>
            ) : null}
            {hosts
              .filter(
                (entry) => connector.context !== 'application' || entry.kind === 'local',
              )
              .map((entry) => (
                <option key={entry.hostId} value={entry.hostId}>
                  {entry.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Installed program path (absolute)
          <input
            aria-label={`Executable for ${connector.id}`}
            value={path}
            onChange={(event) => {
              setPath(event.target.value)
              void abandonDecision()
            }}
            className="hvir-input"
          />
        </label>
        <p>
          This program runs with your account’s access to files, credentials, network and
          other programs. Its working folder and action name do not limit that access or
          guarantee read-only behavior.
        </p>
        <p>
          Working folder:{' '}
          {connector.context === 'application'
            ? 'hvir’s local scratch folder, separate from your project'
            : 'The selected project on the approved host'}{' '}
        </p>
        <details>
          <summary>Execution limits and environment</summary>
          <p>
            Deadline: {connector.timeoutMs / 1000} seconds · Output:{' '}
            {connector.outputBytes} bytes
          </p>
          <p>
            Available environment overrides: {connector.environment.join(', ') || 'None'}.
            The host account’s normal environment is inherited.
          </p>
        </details>

        <details>
          <summary>Advanced configuration</summary>
          <button
            type="button"
            className="hvir-button"
            onClick={() =>
              void run(async (owner) => {
                if (!status?.trustUpdates) return prepareDecision(true)
                await abandonDecision()
                await window.hvir.invoke('extensions:connector-session-end', {
                  installationId: installation,
                  connector: connector.id,
                  host,
                })
                if (!isCurrentOwner(owner)) return
                setBindings((saved) =>
                  saved.map((entry) =>
                    entry.host === host
                      ? {
                          ...entry,
                          trustUpdates: false,
                          availability: 'unavailable',
                          reason: 'unavailable',
                        }
                      : entry,
                  ),
                )
                await refresh(owner)
              })
            }
          >
            {status?.trustUpdates
              ? 'Stop trusting launcher updates'
              : 'Trust updates at this launcher until hvir quits'}
          </button>
          <p>
            {host}:{' '}
            {status?.trustUpdates
              ? status.selectedExecutable
              : path || 'Select a launcher'}
            . New targets at this exact path may run with your account’s access.
            {host !== 'local' ? ' Ends when this SSH connection disconnects.' : ''}
          </p>
          <label>
            Configuration (JSON argument prefix and environment overrides)
            <textarea
              aria-label={`Configuration for ${connector.id}`}
              value={configuration}
              onChange={(event) => {
                setConfiguration(event.target.value)
                void abandonDecision()
              }}
              className="hvir-input"
            />
          </label>
        </details>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await prepareDecision(false)
            })
          }
          className="hvir-button"
        >
          {status?.reason === 'executable-changed'
            ? 'Review update'
            : 'Inspect native access'}
        </button>
        {decision ? (
          <>
            <p>
              {decision.trustUpdates ? (
                <>
                  Trust launcher updates for this session: {decision.approval.host}:{' '}
                  {decision.approval.executable} → {decision.approval.canonicalExecutable}
                  .{decision.preservesBaseline ? ' Saved approval stays unchanged.' : ''}
                </>
              ) : (
                <>
                  Approve {decision.approval.host}:{' '}
                  {decision.approval.canonicalExecutable} for this connector?
                </>
              )}
            </p>
            <pre>{JSON.stringify(decision.approval.configuration, null, 2)}</pre>
            <button
              type="button"
              onClick={() =>
                void run(async (owner) => {
                  await window.hvir.invoke('extensions:connector-approve', {
                    token: decision.token,
                  })
                  if (!isCurrentOwner(owner)) return
                  delete preparation.current.token
                  setDecision(undefined)
                  await refresh(owner)
                })
              }
              className="hvir-button"
            >
              {decision.trustUpdates
                ? 'Trust launcher updates for this session'
                : 'Approve native execution'}
            </button>
            <button
              type="button"
              className="hvir-button"
              onClick={() => void abandonDecision()}
            >
              Cancel
            </button>
          </>
        ) : null}
      </details>
      {status ? (
        <button
          type="button"
          onClick={() =>
            void run(async (owner) => {
              await window.hvir.invoke('extensions:connector-revoke', {
                installationId: installation,
                connector: connector.id,
                host,
              })
              await refresh(owner)
            })
          }
          className="hvir-button"
        >
          Revoke access on {hostLabel}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  )
}

/** Prepared decisions hold a bounded main slot; abandoning UI intent releases only that token. */
function cancelPrepared(token: string): Promise<void> {
  return window.hvir
    .invoke('extensions:connector-cancel-prepared', { token })
    .catch(() => {})
}
