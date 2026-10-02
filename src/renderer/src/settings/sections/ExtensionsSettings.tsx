import { ConnectorSettings } from './ConnectorSettings'
import { ExtensionActions } from '../../extensions/ExtensionActions'
import { ConfirmationDialog } from '../../workbench/ConfirmationDialog'
import { useEffect, useState, type ReactElement } from 'react'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
} from '../../../../shared/extensions/workbench'

export function ExtensionsSettings(): ReactElement {
  const [state, setState] = useState<ExtensionPlatformState>()
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState<ExtensionInstallation>()
  const [forget, setForget] = useState(false)
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
        Place a ready-to-run extension directory, ZIP, or development link in the
        extensions folder, then discover it and inspect its requested access.
      </p>
      <div className="settings-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(() => window.hvir.invoke('extensions:open-folder', undefined))
          }
          className="hvir-button"
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
          className="hvir-button"
        >
          Discover extensions
        </button>
      </div>
      {state?.explanation ? <p role="status">{state.explanation}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {state?.installations.length === 0 ? (
        <p>
          No extensions found. Add a directory or ZIP package, then choose Discover
          extensions.
        </p>
      ) : null}
      {state?.installations.map((installation) => (
        <article className="extension-installation" key={installation.source}>
          <h4>{installation.manifest?.name ?? installation.source}</h4>
          <p>
            Source: {installation.source}
            {installation.kind === 'development'
              ? ' · Development package (linked author directory)'
              : installation.kind === 'zip'
                ? ' · ZIP package'
                : ''}
          </p>
          {installation.acceptedRevision ? (
            <p>
              Accepted revision: {installation.acceptedRevision.slice(0, 12)} · Candidate:{' '}
              {installation.revision?.slice(0, 12) ?? 'unavailable'}
            </p>
          ) : null}
          {installation.retainedIdentity ? (
            <p>Saved setup is kept. Choose Enable before opening views.</p>
          ) : null}
          {installation.acceptedRevision &&
          installation.acceptedRevision !== installation.revision ? (
            <p>
              {installation.revision && !installation.error
                ? 'The package changed. Use Reload or Replace to accept the new revision.'
                : 'Restore or repair the package, then choose Discover extensions and explicitly Enable, Reload or Replace it.'}
            </p>
          ) : null}
          {installation.error ? (
            <p role="alert">{installation.error}</p>
          ) : (
            <>
              <p>
                Package {installation.manifest?.version} · Extension contract{' '}
                {installation.manifest?.contract}
              </p>
              <p>
                Requested UI access: package-local views and declared observations. No
                project files, terminals or direct network access. Native connectors
                require separate approval below.
              </p>
              <p>
                Required capabilities:{' '}
                {installation.manifest?.requiredCapabilities.join(', ') || 'None'}
              </p>
              <p>
                Optional capabilities:{' '}
                {installation.manifest?.optionalCapabilities.join(', ') || 'None'}
              </p>
              {installation.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              {installation.installationId && installation.revision ? (
                <button
                  type="button"
                  disabled={busy || !state.writable || installation.removalPending}
                  onClick={() =>
                    void run(async () =>
                      setState(
                        await window.hvir.invoke('extensions:reload', {
                          source: installation.source,
                          revision: installation.revision!,
                        }),
                      ),
                    )
                  }
                  className="hvir-button"
                >
                  {installation.kind === 'zip' ? 'Replace' : 'Reload'}
                </button>
              ) : null}
              {installation.removalPending ? (
                <p>Package removal is unfinished. Retry Remove to finish cleanup.</p>
              ) : null}
              {installation.enabled ? (
                <>
                  <button
                    type="button"
                    disabled={busy || !state.writable || installation.removalPending}
                    onClick={() =>
                      void run(async () =>
                        setState(
                          await window.hvir.invoke('extensions:disable', {
                            installationId: installation.installationId!,
                          }),
                        ),
                      )
                    }
                    className="hvir-button"
                  >
                    Disable
                  </button>
                  <ConnectorSettings installation={installation} />
                  {installation.installationId ? (
                    <ExtensionActions installationId={installation.installationId} />
                  ) : null}
                  {installation.manifest?.views
                    .filter(
                      (view) => view.placement === 'application' && !view.navigation,
                    )
                    .map((view) => (
                      <button
                        type="button"
                        key={view.id}
                        disabled={busy || !state.writable || installation.removalPending}
                        onClick={() =>
                          void run(() =>
                            window.hvir.invoke('extensions:open-view', {
                              installationId: installation.installationId!,
                              contributionId: view.id,
                            }),
                          )
                        }
                        className="hvir-button"
                      >
                        Open {view.title}
                      </button>
                    ))}
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || !state.writable || installation.removalPending}
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
                  className="hvir-button"
                >
                  Enable
                </button>
              )}
            </>
          )}
          <button
            type="button"
            disabled={busy || !state.writable}
            onClick={() => {
              setForget(false)
              setRemoving(installation)
            }}
            className="hvir-button"
          >
            Remove
          </button>
        </article>
      ))}
      {removing ? (
        <ConfirmationDialog
          nested
          busy={busy}
          labelledBy="extension-remove-title"
          actions={[
            { label: 'Cancel', kind: 'cancel', onSelect: () => setRemoving(undefined) },
            {
              label: 'Confirm remove',
              kind: 'destructive',
              disabled: !state?.writable,
              onSelect: () =>
                void run(async () => {
                  setState(
                    await window.hvir.invoke('extensions:remove', {
                      source: removing.source,
                      ...(removing.sourceIdentity
                        ? { identity: removing.sourceIdentity }
                        : {}),
                      forget,
                    }),
                  )
                  setRemoving(undefined)
                }),
            },
          ]}
        >
          <h4 id="extension-remove-title">
            Remove {removing.manifest?.name ?? removing.source}?
          </h4>
          <p>
            {removing.kind === 'development'
              ? 'Only the development link is deleted. Files in the author directory are kept.'
              : 'The selected package directory or ZIP is moved to the trash.'}
          </p>
          <p>
            Extension views close and access is turned off first. Libraries, project
            skills, issue databases and other data created by the extension are kept.
          </p>

          <label>
            <input
              type="checkbox"
              checked={forget}
              onChange={(event) => setForget(event.target.checked)}
              className="hvir-input"
            />
            Forget saved setup for this extension
          </label>
          <p>
            {forget
              ? 'Reinstall starts with fresh setup and requires Enable.'
              : 'Keep saved setup for reinstall. Enable is still required.'}
          </p>
        </ConfirmationDialog>
      ) : null}
    </section>
  )
}
