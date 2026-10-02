import { useEffect, useState, type ReactElement } from 'react'
import type { AgentAccessState } from '../../../../shared/agent/contract'

/** Trusted workbench controls; guest/public transport cannot configure or decide access. */
export function AgentAccessSettings({
  installation,
}: {
  readonly installation?: string
}): ReactElement {
  const [state, setState] = useState<AgentAccessState>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true,
      updated = false
    const unsubscribe = window.hvir.on('agent:access-changed', (next) => {
      if (current) {
        updated = true
        setState(next)
      }
    })
    void window.hvir.invoke('agent:access', undefined).then(
      (next) => {
        if (current && !updated) setState(next)
      },
      () => {
        if (current) setError('Agent access is unavailable')
      },
    )
    return () => {
      current = false
      void unsubscribe()
    }
  }, [])
  const configure = async (
    enabled: boolean,
    confirmDestructive: boolean,
  ): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setState(
        await window.hvir.invoke('agent:configure', {
          enabled,
          confirmDestructive,
        }),
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Access change failed')
    } finally {
      setBusy(false)
    }
  }
  const configureExtension = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setState(
        await window.hvir.invoke('agent:extension-configure', {
          installation: id,
          enabled,
        }),
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Access change failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="agent-access-settings">
      {installation ? (
        <label>
          <input
            type="checkbox"
            className="hvir-input"
            aria-label="Agent access for this extension"
            disabled={!state || busy || !state.extensionsWritable}
            checked={state?.extensions.includes(installation) ?? false}
            onChange={(event) =>
              state && void configureExtension(installation, event.target.checked)
            }
          />
          Agent access for this extension
          {state && !state.extensionsWritable ? (
            <span className="hvir-meta"> (extension write ownership unavailable)</span>
          ) : null}
        </label>
      ) : (
        <>
          <h4>Agent access</h4>
          <label>
            <input
              type="checkbox"
              className="hvir-input"
              disabled={!state || busy || !state.endpoint}
              checked={state?.enabled ?? false}
              onChange={(event) =>
                state && void configure(event.target.checked, state.confirmDestructive)
              }
            />
            Allow local agents to inspect and present workspace content
          </label>
          <label>
            <select
              className="hvir-input"
              aria-label="Agent authorization"
              disabled={!state || busy}
              value={state?.confirmDestructive ? 'confirm' : 'standing'}
              onChange={(event) =>
                state && void configure(state.enabled, event.target.value === 'confirm')
              }
            >
              <option value="standing">Allow actions within approved access</option>
              <option value="confirm">Also confirm destructive actions</option>
            </select>
          </label>
          <p>
            The harness controls its own approvals. Its sandbox does not constrain work
            executed by hvir. Access does not enable extensions, approve native connectors
            or expand grants. Same-user processes share this access.
          </p>
          <p>
            Terminal defaults: HVIR_AGENT_ENDPOINT, HVIR_AGENT_WORKSPACE,
            HVIR_AGENT_SESSION. Use hvir-agent guide targeting for command setup.
          </p>
          {state?.endpoint ? (
            <p className="hvir-meta">Instance endpoint: {state.endpoint}</p>
          ) : null}
          {state?.explanation ? <p role="status">{state.explanation}</p> : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
