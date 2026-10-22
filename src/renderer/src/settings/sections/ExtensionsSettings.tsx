import type { ExtensionConnectionResult } from '../../../../shared/extensions/connectors'
import { SettingsSection } from '../SettingsSection'
import { DeliveryRecoverySettings } from './DeliveryRecoverySettings'
import { AgentAccessSettings } from './AgentAccessSettings'
import { ExtensionInstallationSettings } from './ExtensionInstallationSettings'
import { ConfirmationDialog } from '../../workbench/ConfirmationDialog'
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
  ExtensionView,
} from '../../../../shared/extensions/workbench'

export interface ExtensionsSettingsHandle {
  cancelInstallation(): void
}

export function ExtensionsSettings({
  onInstalledLanding,
  ref,
}: {
  readonly onInstalledLanding?: (view: ExtensionView) => boolean
  readonly ref?: Ref<ExtensionsSettingsHandle>
}): ReactElement {
  const [state, setState] = useState<ExtensionPlatformState>()
  const [connection, setConnection] = useState<ExtensionConnectionResult>()
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState<ExtensionInstallation>()
  const [forget, setForget] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<ExtensionInstallation | null>()
  const [recoveryAttention, setRecoveryAttention] = useState('')
  const recoveryAttentionId = useId()
  const landingCallback = useRef(onInstalledLanding)
  landingCallback.current = onInstalledLanding
  const currentState = useRef(state)
  currentState.current = state
  const installations = state?.installations ?? []
  const selected =
    selection === null
      ? undefined
      : (installations.find(
          (entry) =>
            (selection?.sourceIdentity &&
              entry.sourceIdentity === selection.sourceIdentity) ||
            entry.source === selection?.source,
        ) ??
        installations.find(
          (entry) =>
            selection?.installationId &&
            entry.installationId === selection.installationId,
        ) ??
        (selection === undefined ? installations[0] : undefined))
  useEffect(() => {
    if (selection !== undefined && selection !== null && selected !== selection)
      setSelection((current) => (current === selection ? (selected ?? null) : current))
    else if (selection === undefined && state)
      setSelection((current) => (current === undefined ? (selected ?? null) : current))
  }, [selected, selection, state])
  const pane = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (pane.current) pane.current.scrollTop = 0
  }, [selected?.source])
  const setupRequest = useRef<string | undefined>(undefined)
  const cancelSetup = (): void => {
    const request = setupRequest.current
    setupRequest.current = undefined
    if (request)
      void window.hvir.invoke('extensions:add-cancel-setup', { request }).catch(() => {})
  }
  useImperativeHandle(ref, () => ({ cancelInstallation: cancelSetup }))
  useEffect(() => {
    return () => cancelSetup()
  }, [])
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
      currentState.current = next
      setState(next)
      if (!next.writable) cancelSetup()
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
      description="Extension changes apply immediately. App preferences use Save below."
    >
      <div className="extension-settings-content extension-configuration-layout">
        <div className="extension-settings-sidebar">
          <nav
            className="extension-installation-list"
            aria-label="Extensions"
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
              ]
              const index = buttons.indexOf(event.target as HTMLButtonElement)
              if (
                index < 0 ||
                !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
              )
                return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                      buttons.length
              buttons[next]?.focus()
              buttons[next]?.click()
            }}
          >
            <button
              type="button"
              className="hvir-button"
              aria-label="Extension settings"
              aria-describedby={recoveryAttention ? recoveryAttentionId : undefined}
              aria-current={!selected ? 'true' : undefined}
              onClick={() => {
                cancelSetup()
                setSelection(null)
                setRemoving(undefined)
              }}
            >
              <strong>Extension settings</strong>
              {recoveryAttention ? (
                <small id={recoveryAttentionId}>{recoveryAttention}</small>
              ) : null}
            </button>
            {installations.map((installation) => (
              <button
                type="button"
                className="hvir-button"
                key={installation.source}
                data-source={installation.source}
                aria-current={selected === installation ? 'true' : undefined}
                onClick={() => {
                  cancelSetup()
                  setSelection(installation)
                  setRemoving(undefined)
                }}
              >
                <strong>{installation.manifest?.name ?? installation.source}</strong>
                <small>
                  {installation.removalPending
                    ? 'Removal unfinished'
                    : installation.error
                      ? 'Needs attention'
                      : installation.enabled
                        ? 'Enabled'
                        : installation.retainedIdentity
                          ? 'Saved setup · not enabled'
                          : 'Not enabled'}
                </small>
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="hvir-button extension-add-action"
            disabled={busy || !state?.writable}
            onClick={() =>
              void run(async () => {
                const observed = publication.current
                const request = crypto.randomUUID()
                try {
                  setConnection(undefined)
                  setupRequest.current = request
                  const next = await window.hvir.invoke('extensions:add', { request })
                  const landing = next.installed?.landing
                  let consumed = false
                  try {
                    if (observed === publication.current) {
                      setState(next)
                    }
                    if (setupRequest.current !== request) return
                    if (observed !== publication.current && next.explanation)
                      setError(next.explanation)
                    setConnection(next.connection)
                    const added =
                      next.installed &&
                      (observed === publication.current
                        ? next.installations
                        : (currentState.current?.installations ?? [])
                      ).find(
                        (entry) =>
                          entry.installationId === next.installed!.installationId,
                      )
                    if (added) setSelection(added)
                    if (landing) consumed = landingCallback.current?.(landing) === true
                  } finally {
                    if (landing && next.installed?.landingCreated && !consumed)
                      await window.hvir
                        .invoke('extensions:close-view', {
                          viewId: landing.id,
                        })
                        .catch((cause: unknown) => {
                          throw new Error(
                            'Extension installed, but its view could not close. Restart hvir to finish cleanup.',
                            { cause },
                          )
                        })
                  }
                } finally {
                  if (setupRequest.current === request) setupRequest.current = undefined
                }
              })
            }
          >
            Add extension…
          </button>
        </div>
        <div className="extension-settings-pane" ref={pane}>
          {state?.explanation ? <p role="status">{state.explanation}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {connection?.connections
            .filter((entry) => entry.outcome !== 'connected')
            .map((entry) => (
              <p
                key={entry.connector}
                role={entry.outcome === 'interrupted-uncertain' ? 'alert' : 'status'}
              >
                {entry.connector}:{' '}
                {entry.explanation ??
                  'Not connected. The extension is installed; choose Connect under Program access when ready.'}
              </p>
            ))}
          {state?.installations.length === 0 && (state.writable || !state.explanation) ? (
            <p>
              No extensions found. Choose Add extension to select a directory or ZIP
              package.
            </p>
          ) : null}
          <div className="extension-shared-settings" hidden={!!selected}>
            <h4>Extension settings</h4>
            <AgentAccessSettings />
            <DeliveryRecoverySettings
              active={!selected}
              platformState={state}
              onAttention={setRecoveryAttention}
            />
            <details className="extension-author-controls">
              <summary>Author and discovery controls</summary>
              <p>
                For development links or packages copied manually, open the extensions
                folder and discover them.
              </p>
              <div className="settings-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      window.hvir.invoke('extensions:open-folder', undefined),
                    )
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
                      setState(
                        await window.hvir.invoke('extensions:discover', undefined),
                      ),
                    )
                  }
                  className="hvir-button"
                >
                  Discover extensions
                </button>
              </div>
            </details>
          </div>
          {selected ? (
            <ExtensionInstallationSettings
              key={selected.source}
              installation={selected}
              writable={state!.writable}
              busy={busy}
              onRun={run}
              onState={setState}
              onRemove={(installation) => {
                setForget(false)
                setRemoving(installation)
              }}
            />
          ) : null}
        </div>
      </div>
      {removing ? (
        <ConfirmationDialog
          className="extension-confirmation-dialog"
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

          <label className="extension-forget-choice">
            <input
              type="checkbox"
              checked={forget}
              onChange={(event) => setForget(event.target.checked)}
              className="hvir-input"
            />
            <span>Forget saved setup for this extension</span>
          </label>
          <p>
            {forget
              ? 'Reinstall with Add extension starts with fresh setup. Delivered files stay where they are; hvir will no longer update or remove them. Unresolved delivery objects stay in Delivery recovery under Extension settings.'
              : 'Keep saved setup and completed delivery records for reinstall with Add extension.'}
          </p>
        </ConfirmationDialog>
      ) : null}
    </SettingsSection>
  )
}
