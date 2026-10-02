import { useEffect, useState, type ReactElement } from 'react'
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
  return (
    <>
      {installation.manifest?.connectors?.map((connector) => (
        <ConnectorSetup
          key={connector.id}
          installation={installation.installationId!}
          connector={connector}
        />
      ))}
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
      <legend>Native connector: {connector.id}</legend>
      <p>{connector.description}</p>
      <p>
        This executable runs with your account’s authority on the selected host. It can
        access files, credentials, network and other programs. Its working directory and
        an action’s label do not confine it or prove that it is read-only. Enabling
        extension views does not approve native execution.
      </p>
      <p>
        Working context:{' '}
        {connector.context === 'application'
          ? 'Local application scratch directory, independent of the selected workspace'
          : 'Explicitly targeted workspace on the approved host'}{' '}
        · Deadline: {connector.timeoutMs / 1000} seconds · Output: {connector.outputBytes}{' '}
        bytes
      </p>
      <p>
        Available environment overrides: {connector.environment.join(', ') || 'None'}. The
        host account’s normal environment is inherited.
      </p>
      <p role="status">
        {status?.availability ?? 'unavailable'}
        {status?.executable ? ` · ${status.host}: ${status.executable}` : ''}
        {status?.explanation ? ` · ${status.explanation}` : ''}
      </p>
      <label>
        Connector host
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
        Absolute installed executable path
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
            Approve {decision.approval.host}: {decision.approval.canonicalExecutable} for
            this connector?
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
