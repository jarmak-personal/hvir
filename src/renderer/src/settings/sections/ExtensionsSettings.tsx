import { SettingsSection } from '../SettingsSection'
import { DeliveryRecoverySettings } from './DeliveryRecoverySettings'
import { SourceSettings } from './SourceSettings'
import { AgentAccessSettings } from './AgentAccessSettings'
import { ConnectorSettings } from './ConnectorSettings'
import { ExtensionActions } from '../../extensions/ExtensionActions'
import { ConfirmationDialog } from '../../workbench/ConfirmationDialog'
import { useEffect, useRef, useState, type ReactElement } from 'react'
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
  const publication = useRef(0)
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
      publication.current++
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
    <SettingsSection
      section="extensions"
      className="extension-settings"
      title="Extensions"
      description="Add an extension, review the access it needs, then choose Enable."
    >
      <div className="settings-section-scroll extension-settings-content">
        <div className="settings-actions">
          <button
            type="button"
            className="hvir-button"
            disabled={busy || !state?.writable}
            onClick={() =>
              void run(async () => {
                const observed = publication.current
                const next = await window.hvir.invoke('extensions:add', undefined)
                if (observed === publication.current) setState(next)
              })
            }
          >
            Add extension…
          </button>
        </div>
        <details className="extension-author-controls">
          <summary>Author and discovery controls</summary>
          <p>
            For development links or packages copied manually, open the extensions folder
            and discover them.
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
        </details>
        {state?.explanation ? <p role="status">{state.explanation}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {state?.installations.length === 0 && (state.writable || !state.explanation) ? (
          <p>
            No extensions found. Choose Add extension to select a directory or ZIP
            package.
          </p>
        ) : null}
        <DeliveryRecoverySettings />
        {state?.installations.map((installation) => (
          <article className="extension-installation" key={installation.source}>
            <h4>{installation.manifest?.name ?? installation.source}</h4>
            <p className="hvir-meta">
              {installation.enabled ? 'Enabled' : 'Not enabled'} · Version{' '}
              {installation.manifest?.version ?? 'unknown'}
            </p>
            <details className="extension-package-details">
              <summary>Package details</summary>
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
                  Accepted revision: {installation.acceptedRevision.slice(0, 12)} ·
                  Candidate: {installation.revision?.slice(0, 12) ?? 'unavailable'}
                </p>
              ) : null}
            </details>
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
            {!installation.error ? (
              <>
                <p>
                  Extension views show their own content and information shared by hvir.
                  They have no automatic access to project files, terminals or direct
                  network connections. File and program access needs separate approval
                  below.
                </p>
                {installation.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                <details className="extension-package-details">
                  <summary>Requested capabilities</summary>
                  <p>Extension contract {installation.manifest?.contract}</p>
                  <p>
                    Required:{' '}
                    {installation.manifest?.requiredCapabilities.join(', ') || 'None'}
                  </p>
                  <p>
                    Optional:{' '}
                    {installation.manifest?.optionalCapabilities.join(', ') || 'None'}
                  </p>
                </details>
              </>
            ) : null}
            <div className="settings-actions extension-installation-actions">
              {!installation.error ? (
                <>
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
                  {installation.enabled ? (
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
              ) : null}
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
            </div>
            {installation.error ? (
              <p role="alert">{installation.error}</p>
            ) : (
              <>
                {installation.removalPending ? (
                  <p>Package removal is unfinished. Retry Remove to finish cleanup.</p>
                ) : null}
                {installation.enabled ? (
                  <>
                    <AgentAccessSettings installation={installation.installationId} />
                    <ConnectorSettings installation={installation} />
                    <SourceSettings installation={installation} />
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
                          disabled={
                            busy || !state.writable || installation.removalPending
                          }
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
                ) : null}
              </>
            )}
          </article>
        ))}
        <AgentAccessSettings />
      </div>
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
              ? 'Reinstall starts with fresh setup and requires Enable. Delivered files stay where they are; hvir will no longer update or remove them. Unresolved delivery objects stay in recovery above.'
              : 'Keep saved setup and completed delivery records for reinstall. Enable is still required.'}
          </p>
        </ConfirmationDialog>
      ) : null}
    </SettingsSection>
  )
}
