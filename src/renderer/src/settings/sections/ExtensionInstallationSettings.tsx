import { useState, type ReactElement } from 'react'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
} from '../../../../shared/extensions/workbench'
import { AgentAccessSettings } from './AgentAccessSettings'
import { ConnectorSettings } from './ConnectorSettings'
import { SourceSettings } from './SourceSettings'
import { ExtensionActions } from '../../extensions/ExtensionActions'
import { ExtensionViewLauncher } from './ExtensionViewLauncher'
import { ExtensionSetupSettings } from './ExtensionSetupSettings'

/** Stable selected-package lifecycle chrome; access configuration owns proposal retirement. */
export function ExtensionInstallationSettings({
  installation,
  writable,
  busy,
  onRun,
  onState,
  onRemove,
}: {
  readonly installation: ExtensionInstallation
  readonly writable: boolean
  readonly busy: boolean
  readonly onRun: (operation: () => Promise<unknown>) => Promise<void>
  readonly onState: (state: ExtensionPlatformState) => void
  readonly onRemove: (installation: ExtensionInstallation) => void
}): ReactElement {
  const [lifecycleOpen, setLifecycleOpen] = useState(
    () => !installation.enabled || !!installation.error || !!installation.removalPending,
  )
  return (
    <article
      className="extension-installation"
      aria-label={`${installation.manifest?.name ?? installation.source} configuration`}
    >
      <header className="extension-installation-heading">
        <div>
          <h4>{installation.manifest?.name ?? installation.source}</h4>
          <p className="hvir-meta">
            {installation.enabled ? 'Enabled' : 'Not enabled'} · Version{' '}
            {installation.manifest?.version ?? 'unknown'}
          </p>
        </div>
      </header>

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
          {!installation.enabled ? (
            <p>
              Enabling views does not give access to project files, terminals or network.
              Reading files and running programs need separate access below.
            </p>
          ) : null}
          {installation.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </>
      ) : null}
      <details
        className="extension-lifecycle"
        open={lifecycleOpen}
        onToggle={(event) => setLifecycleOpen(event.currentTarget.open)}
        onClickCapture={(event) => {
          if (
            event.target instanceof HTMLButtonElement &&
            !event.target.disabled &&
            document.activeElement === event.target
          )
            event.currentTarget.querySelector<HTMLElement>('summary')?.focus()
        }}
      >
        <summary>Manage extension</summary>
        <div className="settings-actions extension-installation-actions">
          {!installation.error ? (
            <>
              {installation.installationId && installation.revision ? (
                <button
                  type="button"
                  disabled={busy || !writable || installation.removalPending}
                  onClick={() =>
                    void onRun(async () =>
                      onState(
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
                  disabled={busy || !writable || installation.removalPending}
                  onClick={() =>
                    void onRun(async () =>
                      onState(
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
                  disabled={busy || !writable || installation.removalPending}
                  onClick={() =>
                    void onRun(async () =>
                      onState(
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
            disabled={busy || !writable}
            onClick={() => {
              onRemove(installation)
            }}
            className="hvir-button"
          >
            Remove
          </button>
        </div>
      </details>
      {installation.error ? (
        <p role="alert">{installation.error}</p>
      ) : (
        <>
          {installation.removalPending ? (
            <p>Package removal is unfinished. Retry Remove to finish cleanup.</p>
          ) : null}
          {installation.enabled ? (
            <ExtensionConfigurationSettings
              key={`${installation.installationId ?? installation.sourceIdentity ?? installation.source}:${installation.acceptedRevision ?? ''}:${installation.revision ?? ''}:${installation.enabled}`}
              installation={installation}
              writable={writable}
              busy={busy}
              onRun={onRun}
            />
          ) : null}
        </>
      )}
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
            Accepted revision: {installation.acceptedRevision.slice(0, 12)} · Candidate:{' '}
            {installation.revision?.slice(0, 12) ?? 'unavailable'}
          </p>
        ) : null}
      </details>
      {!installation.error ? (
        <details className="extension-package-details">
          <summary>Requested capabilities</summary>
          <p>Extension contract {installation.manifest?.contract}</p>
          <p>
            Required: {installation.manifest?.requiredCapabilities.join(', ') || 'None'}
          </p>
          <p>
            Optional: {installation.manifest?.optionalCapabilities.join(', ') || 'None'}
          </p>
        </details>
      ) : null}
    </article>
  )
}

/** A new authority identity or revision discards unconfirmed access and local setup state. */
function ExtensionConfigurationSettings({
  installation,
  writable,
  busy,
  onRun,
}: {
  readonly installation: ExtensionInstallation
  readonly writable: boolean
  readonly busy: boolean
  readonly onRun: (operation: () => Promise<unknown>) => Promise<void>
}): ReactElement {
  const [tab, setTab] = useState<'programs' | 'files' | 'actions'>('programs')
  const [accessRevision, setAccessRevision] = useState(0)
  return (
    <>
      {installation.installationId ? (
        <ExtensionSetupSettings
          installation={installation.installationId}
          disabled={busy || !writable || !!installation.removalPending}
          onSettled={() => setAccessRevision((value) => value + 1)}
        />
      ) : null}
      <nav className="extension-configuration-tabs" aria-label="Extension configuration">
        {(['programs', 'files', 'actions'] as const).map((id) => (
          <button
            type="button"
            className="hvir-button"
            key={id}
            aria-current={tab === id ? 'true' : undefined}
            onClick={() => setTab(id)}
          >
            {id === 'programs'
              ? 'Program access'
              : id === 'files'
                ? 'File access'
                : 'Extension actions'}
          </button>
        ))}
      </nav>
      {tab === 'programs' ? (
        <ConnectorSettings key={accessRevision} installation={installation} />
      ) : null}
      {tab === 'files' ? (
        <SourceSettings key={accessRevision} installation={installation} />
      ) : null}
      {tab === 'actions' ? (
        <>
          <AgentAccessSettings installation={installation.installationId} />
          {installation.installationId ? (
            <ExtensionActions installationId={installation.installationId} />
          ) : null}
        </>
      ) : null}
      <ExtensionViewLauncher
        installation={installation}
        disabled={busy || !writable || !!installation.removalPending}
        onRun={onRun}
      />
    </>
  )
}
