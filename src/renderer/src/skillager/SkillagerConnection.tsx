import type { ReactElement } from 'react'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerConnection({
  controller,
}: {
  readonly controller: SkillagerController
}): ReactElement {
  if (controller.probing) return <p role="status">Checking local Skillager…</p>
  if (controller.connection)
    return (
      <div className="skillager-connection">
        <p>Connected to {controller.connection.library.root.path}</p>
        <button type="button" onClick={controller.disconnect}>
          Disconnect
        </button>
      </div>
    )
  if (!controller.probe)
    return (
      <button type="button" onClick={() => void controller.check()}>
        Check Skillager
      </button>
    )
  if (!controller.probe.ok)
    return (
      <div className="skillager-connection">
        {controller.probe.reason === 'missing' ? (
          <>
            <p>Skillager wasn’t found. Install Skillager in your local terminal:</p>
            <code className="skillager-install">uv tool install skillager</code>
          </>
        ) : (
          <p role="status">{controller.probe.message}</p>
        )}
        <button type="button" onClick={() => void controller.check()}>
          Check again
        </button>
      </div>
    )
  const probe = controller.probe.value
  return (
    <div className="skillager-connection">
      <p>
        {probe.version}
        <br />
        <span className="skillager-path">{probe.executable.path}</span>
      </p>
      {probe.library ? (
        <>
          <p>
            Personal library
            <br />
            <span className="skillager-path">{probe.library.root.path}</span>
          </p>
          <p>
            Connect to browse metadata. Content opens only when you choose to review it.
          </p>
          <button
            type="button"
            disabled={controller.connecting}
            onClick={() => void controller.connect()}
          >
            {controller.connecting ? 'Connecting…' : 'Connect library'}
          </button>
        </>
      ) : (
        <p>Initialize your personal library in Skillager, then choose Check again.</p>
      )}
      {controller.connectionError ? (
        <p role="alert">{controller.connectionError}</p>
      ) : null}
      <button type="button" onClick={() => void controller.check()}>
        Check again
      </button>
    </div>
  )
}
