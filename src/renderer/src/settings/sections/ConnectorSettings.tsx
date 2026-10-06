import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ProjectHostOption } from '../../../../shared'
import type { ExtensionInstallation } from '../../../../shared/extensions/workbench'
import type {
  ExtensionConnectorApproval,
  ExtensionConnectorDeclaration,
  ExtensionConnectorStatus,
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
  const connectionRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!connector.setup) return
    const cancel = (): void => {
      const request = connectionRequest.current
      connectionRequest.current = undefined
      if (request)
        void window.hvir
          .invoke('extensions:connection-cancel', { request })
          .catch(() => {})
    }
    const unsubscribe = window.hvir.on('extensions:foreground-changed', (foreground) => {
      if (!foreground) cancel()
    })
    return () => {
      cancel()
      void unsubscribe()
    }
  }, [connector.setup])
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [host, setHost] = useState('local')
  const [path, setPath] = useState('')
  const [configuration, setConfiguration] = useState('{"args":[],"env":{}}')
  const [decision, setDecision] = useState<{
    token: string
    approval: ExtensionConnectorApproval
  }>()
  const [status, setStatus] = useState<ExtensionConnectorStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Native setup failed')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let current = true
    void window.hvir
      .invoke('extensions:connector-settings', { installationId: installation })
      .then(
        (value) => {
          if (current) {
            setHosts(value.hosts)
            setStatus(value.connectors.find((entry) => entry.connector === connector.id))
          }
        },
        () => {
          if (current) setError('Native settings are unavailable')
        },
      )
    return () => {
      current = false
    }
  }, [installation, connector])
  return (
    <fieldset disabled={busy}>
      <legend>Program access: {connector.id}</legend>
      <p>{connector.description}</p>
      <p role="status">
        {status?.availability === 'supported'
          ? 'Approved'
          : status?.availability === 'disconnected'
            ? 'Host disconnected'
            : 'Unavailable'}
        {status?.executable ? ` · ${status.host}: ${status.executable}` : ''}
        {status?.explanation ? ` · ${status.explanation}` : ''}
      </p>
      {connector.setup ? (
        <button
          type="button"
          className="hvir-button"
          onClick={() =>
            void run(async () => {
              const request = crypto.randomUUID()
              connectionRequest.current = request
              const result = await window.hvir.invoke('extensions:connector-connect', {
                request,
                installationId: installation,
                connector: connector.id,
              })
              if (connectionRequest.current !== request) return
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
              setStatus(
                (
                  await window.hvir.invoke('extensions:connector-settings', {
                    installationId: installation,
                  })
                ).connectors.find((entry) => entry.connector === connector.id),
              )
            })
          }
        >
          Connect {connector.setup.executable}
        </button>
      ) : null}
      <details open={!connector.setup}>
        <summary>Manual program configuration</summary>
        <label>
          Host
          <select
            aria-label={`Host for ${connector.id}`}
            value={host}
            onChange={(event) => {
              setHost(event.target.value)
              setDecision(undefined)
            }}
            className="hvir-input"
          >
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
              setDecision(undefined)
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
          <label>
            Configuration (JSON argument prefix and environment overrides)
            <textarea
              aria-label={`Configuration for ${connector.id}`}
              value={configuration}
              onChange={(event) => {
                setConfiguration(event.target.value)
                setDecision(undefined)
              }}
              className="hvir-input"
            />
          </label>
        </details>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              setDecision(
                await window.hvir.invoke('extensions:connector-prepare', {
                  installationId: installation,
                  connector: connector.id,
                  host,
                  executable: path,
                  configuration: JSON.parse(
                    configuration,
                  ) as ExtensionConnectorApproval['configuration'],
                }),
              )
            })
          }
          className="hvir-button"
        >
          Inspect native access
        </button>
        {decision ? (
          <>
            <p>
              Approve {decision.approval.host}: {decision.approval.canonicalExecutable}{' '}
              for this connector?
            </p>
            <pre>{JSON.stringify(decision.approval.configuration, null, 2)}</pre>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await window.hvir.invoke('extensions:connector-approve', {
                    token: decision.token,
                  })
                  setDecision(undefined)
                  setStatus(
                    (
                      await window.hvir.invoke('extensions:connector-settings', {
                        installationId: installation,
                      })
                    ).connectors.find((entry) => entry.connector === connector.id),
                  )
                })
              }
              className="hvir-button"
            >
              Approve native execution
            </button>
          </>
        ) : null}
      </details>
      <button
        type="button"
        onClick={() =>
          void run(async () => {
            await window.hvir.invoke('extensions:connector-revoke', {
              installationId: installation,
              connector: connector.id,
            })
            setDecision(undefined)
            setStatus(undefined)
          })
        }
        className="hvir-button"
      >
        Revoke native access
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  )
}
