import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionPlatformState } from '../../../../shared/extensions/workbench'

export function ExtensionsSettings(): ReactElement {
  const [state, setState] = useState<ExtensionPlatformState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Extension operation failed')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let current = true
    let updated = false
    const dispose = window.hvir.on('extensions:state-changed', (next) => {
      if (!current) return
      updated = true
      setState(next)
    })
    void window.hvir.invoke('extensions:state', undefined).then(
      (next) => {
        if (current && !updated) setState(next)
      },
      (reason: unknown) => {
        if (current && !updated)
          setError(
            reason instanceof Error ? reason.message : 'Extensions are unavailable',
          )
      },
    )
    return () => {
      current = false
      void dispose()
    }
  }, [])
  return (
    <section
      className="settings-section extension-settings"
      aria-labelledby="settings-extensions-title"
    >
      <h3 id="settings-extensions-title" tabIndex={-1}>
        Extensions
      </h3>
      <p>
        Place a ready-to-run extension directory in the extensions folder, then discover
        it and inspect its requested access.
      </p>
      <div className="settings-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(() => window.hvir.invoke('extensions:open-folder', undefined))
          }
        >
          Open extensions folder
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setState(await window.hvir.invoke('extensions:discover', undefined)),
            )
          }
        >
          Discover extensions
        </button>
      </div>
      {state?.explanation ? <p role="status">{state.explanation}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {state?.installations.length === 0 ? (
        <p>
          No extensions found. Add an unpacked package, then choose Discover extensions.
        </p>
      ) : null}
      {state?.installations.map((installation) => (
        <article className="extension-installation" key={installation.source}>
          <h4>{installation.manifest?.name ?? installation.source}</h4>
          {installation.error ? (
            <p role="alert">{installation.error}</p>
          ) : (
            <>
              <p>
                Package {installation.manifest?.version} · Extension contract{' '}
                {installation.manifest?.contract}
              </p>
              <p>
                Requested access: package-local views only. No project files, terminals,
                network, or executable access.
              </p>
              <p>
                Required capabilities:{' '}
                {installation.manifest?.requiredCapabilities.join(', ') || 'None'}
              </p>
              <p>
                Optional capabilities:{' '}
                {installation.manifest?.optionalCapabilities.join(', ') || 'None'}
              </p>
              {installation.enabled &&
              installation.acceptedRevision !== installation.revision ? (
                <p>
                  The package changed outside hvir. Open views continue using the accepted
                  revision. Disable and enable to accept the discovered revision.
                </p>
              ) : null}
              {installation.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              {installation.enabled ? (
                <>
                  <button
                    type="button"
                    disabled={busy || !state.writable}
                    onClick={() =>
                      void run(async () =>
                        setState(
                          await window.hvir.invoke('extensions:disable', {
                            installationId: installation.installationId!,
                          }),
                        ),
                      )
                    }
                  >
                    Disable
                  </button>
                  {installation.manifest?.views.map((view) => (
                    <button
                      type="button"
                      key={view.id}
                      disabled={busy || !state.writable}
                      onClick={() =>
                        void run(() =>
                          window.hvir.invoke('extensions:open-view', {
                            installationId: installation.installationId!,
                            contributionId: view.id,
                          }),
                        )
                      }
                    >
                      Open {view.title}
                    </button>
                  ))}
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || !state.writable}
                  onClick={() =>
                    void run(async () =>
                      setState(
                        await window.hvir.invoke('extensions:enable', {
                          source: installation.source,
                          revision: installation.revision!,
                        }),
                      ),
                    )
                  }
                >
                  Enable
                </button>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  )
}
