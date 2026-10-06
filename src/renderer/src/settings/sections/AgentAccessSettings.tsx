import { useEffect, useState, type ReactElement } from 'react'
import type {
  AgentAccessState,
  AgentForwardGrant,
} from '../../../../shared/agent/contract'

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
  const configureForward = async (
    grant: AgentForwardGrant,
    enabled: boolean,
  ): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setState(await window.hvir.invoke('agent:forward-grant', { grant, enabled }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'SSH grant change failed')
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
            <span className="hvir-meta">
              {' '}
              Close another hvir instance using this data folder, or check the extension
              setup above.
            </span>
          ) : null}
        </label>
      ) : (
        <>
          <h4>Agent access</h4>
          <label>
            <input
              type="checkbox"
              className="hvir-input"
              disabled={!state || busy || !state.ready}
              checked={state?.enabled ?? false}
              onChange={(event) =>
                state && void configure(event.target.checked, state.confirmDestructive)
              }
            />
            Allow agents to inspect and present workspace content
          </label>
          <p>
            Work through hvir uses the access approved here, regardless of an agent’s own
            prompts or sandbox. Programs and folders need separate approval. Other
            processes running as your account share this access.
          </p>
          {(state?.forwards ?? []).map((forward) => (
            <p key={forward.host} role="status">
              SSH agent access: {forward.host} — {forward.availability} ·{' '}
              {forward.grants.length} enabled grant selections
              {forward.explanation ? ` · ${forward.explanation}` : ''}
            </p>
          ))}
          <details>
            <summary>
              Agent permissions ·{' '}
              {state
                ? state.confirmDestructive
                  ? 'confirm deletions and replacements'
                  : 'actions within approved access'
                : 'checking access'}
            </summary>
            <label>
              <select
                className="hvir-input"
                aria-label="Agent authorization"
                disabled={!state || busy || !state.ready}
                value={state?.confirmDestructive ? 'confirm' : 'standing'}
                onChange={(event) =>
                  state && void configure(state.enabled, event.target.value === 'confirm')
                }
              >
                <option value="standing">Allow actions within approved access</option>
                <option value="confirm">Also confirm deletions and replacements</option>
              </select>
            </label>
            {(state?.forwards ?? []).map((forward) => (
              <div key={forward.host}>
                <p>
                  SSH agent access: {forward.host} — {forward.availability}
                  {forward.explanation ? `: ${forward.explanation}` : ''}
                </p>
                <p>
                  Processes under that SSH account and remote root can use its socket.
                  Default access stays on that host.
                </p>
                {[
                  ...(state?.forwardOptions ?? []),
                  ...forward.grants.filter(
                    (grant) =>
                      !(state?.forwardOptions ?? []).some(
                        (choice) => JSON.stringify(choice) === JSON.stringify(grant),
                      ),
                  ),
                ]
                  .filter(
                    (grant, index, all) =>
                      grant.host === forward.host &&
                      all.findIndex(
                        (choice) => JSON.stringify(choice) === JSON.stringify(grant),
                      ) === index,
                  )
                  .map((grant) => (
                    <label key={JSON.stringify(grant)}>
                      <input
                        type="checkbox"
                        className="hvir-input"
                        disabled={
                          busy || !state?.enabled || forward.availability !== 'ready'
                        }
                        checked={forward.grants.some(
                          (choice) => JSON.stringify(choice) === JSON.stringify(grant),
                        )}
                        onChange={(event) =>
                          void configureForward(grant, event.target.checked)
                        }
                      />
                      Allow {grant.installation}/{grant.action} to run its approved native
                      {grant.capability === 'delivery.capture'
                        ? 'export capture'
                        : 'connector'}{' '}
                      on {grant.executionHost} for {grant.workspace}
                    </label>
                  ))}
              </div>
            ))}
            <details>
              <summary>Agent connection details</summary>
              <p>
                Terminal defaults: HVIR_AGENT_ENDPOINT, HVIR_AGENT_WORKSPACE,
                HVIR_AGENT_SESSION. Use hvir-agent guide targeting for command setup.
              </p>
              {state?.endpoint ? (
                <p className="hvir-meta">Instance endpoint: {state.endpoint}</p>
              ) : null}
            </details>
          </details>
          {state?.explanation ? <p role="status">{state.explanation}</p> : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
