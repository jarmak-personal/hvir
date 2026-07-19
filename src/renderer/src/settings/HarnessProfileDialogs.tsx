import { useEffect, useRef, type ReactElement, type RefObject } from 'react'

import {
  hostPath,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HostPath,
} from '../../../shared'

export function UnsavedHarnessProfileDialog({
  profileName,
  busy,
  error,
  onKeepEditing,
  onDiscard,
  onSave,
}: {
  readonly profileName: string
  readonly busy: boolean
  readonly error?: string
  readonly onKeepEditing: () => void
  readonly onDiscard: () => void
  readonly onSave: () => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  useDialogFocusTrap(dialogRef, onKeepEditing, busy, keepEditingRef)
  return (
    <div className="modal-backdrop nested">
      <section
        className="project-dialog unsaved-harness-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-harness-title"
        tabIndex={-1}
      >
        <h3 id="unsaved-harness-title">Unsaved harness profile</h3>
        <p>
          <strong>{profileName}</strong> has unsaved changes. Save this harness profile
          before continuing?
        </p>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button
            ref={keepEditingRef}
            type="button"
            disabled={busy}
            onClick={onKeepEditing}
          >
            Keep editing
          </button>
          <button type="button" disabled={busy} onClick={onDiscard}>
            Discard changes
          </button>
          <button type="button" disabled={busy} onClick={() => void onSave()}>
            Save harness profile
          </button>
        </div>
      </section>
    </div>
  )
}

export function AddHarnessDialog({
  providers,
  configuredProviderIds,
  pending,
  selected,
  detected,
  manualProviderId,
  busy,
  error,
  onCancel,
  onRefresh,
  onToggle,
  onManualProvider,
  onManual,
  onMaterialize,
}: {
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly configuredProviderIds: ReadonlySet<HarnessProviderId>
  readonly pending: ReadonlySet<HarnessProviderId>
  readonly selected: ReadonlySet<HarnessProviderId>
  readonly detected: readonly HarnessProviderDescriptor[]
  readonly manualProviderId?: HarnessProviderId
  readonly busy: boolean
  readonly error?: string
  readonly onCancel: () => void
  readonly onRefresh: () => void
  readonly onToggle: (providerId: HarnessProviderId, checked: boolean) => void
  readonly onManualProvider: (providerId: HarnessProviderId) => void
  readonly onManual: (providerId: HarnessProviderId) => void
  readonly onMaterialize: () => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(dialogRef, onCancel, busy)
  return (
    <div className="modal-backdrop nested">
      <section
        className="project-dialog add-harness-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-harness-title"
        tabIndex={-1}
      >
        <div className="add-harness-heading">
          <div>
            <h3 id="add-harness-title">Add a harness</h3>
            <p>Choose installed harnesses to add as editable global profiles.</p>
          </div>
          <button
            type="button"
            disabled={busy || pending.size > 0}
            onClick={onRefresh}
          >
            Refresh
          </button>
        </div>
        <div className="add-harness-candidates" aria-live="polite">
          {detected.map((provider) => {
            const checking = pending.has(provider.id)
            const alreadyConfigured = configuredProviderIds.has(provider.id)
            return (
              <label
                key={provider.id}
                className={alreadyConfigured ? 'configured' : undefined}
              >
                <input
                  type="checkbox"
                  disabled={checking || busy || alreadyConfigured}
                  checked={!alreadyConfigured && selected.has(provider.id)}
                  onChange={(event) => onToggle(provider.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{provider.profileTemplate?.displayName}</strong>
                  <small>
                    {alreadyConfigured
                      ? 'Already added · use Manual profile for another'
                      : checking
                        ? 'Checking…'
                        : 'Installed on this host'}
                  </small>
                </span>
              </label>
            )
          })}
          {detected.length === 0 && pending.size === 0 ? (
            <p>No bundled harnesses were detected on this host.</p>
          ) : null}
        </div>
        <div className="add-harness-manual">
          <label>
            <span>Manual profile</span>
            <select
              value={manualProviderId ?? ''}
              disabled={busy || !manualProviderId}
              onChange={(event) =>
                onManualProvider(event.currentTarget.value as HarnessProviderId)
              }
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.default
                    ? 'Additional shell'
                    : !provider.profileTemplate
                      ? 'Custom command'
                      : `${provider.displayName} with custom settings`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !manualProviderId}
            onClick={() => {
              if (manualProviderId) onManual(manualProviderId)
            }}
          >
            Configure manually…
          </button>
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void onMaterialize()}
          >
            Add selected
          </button>
        </div>
      </section>
    </div>
  )
}

export function HarnessFolderPicker({
  root,
  current,
  parent,
  directories,
  error,
  onCancel,
  onNavigate,
  onSelect,
}: {
  readonly root: HostPath
  readonly current: HostPath
  readonly parent: HostPath
  readonly directories: readonly { readonly name: string }[]
  readonly error?: string
  readonly onCancel: () => void
  readonly onNavigate: (path: HostPath) => void
  readonly onSelect: (path: HostPath) => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(dialogRef, onCancel, false)
  return (
    <div className="modal-backdrop nested">
      <section
        className="project-dialog harness-folder-picker"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-folder-title"
        tabIndex={-1}
      >
        <h3 id="harness-folder-title">Choose folder on {root.hostId}</h3>
        <code>{current.path}</code>
        <div className="harness-folder-list">
          <button
            type="button"
            disabled={current.path === '/'}
            onClick={() => onNavigate(parent)}
          >
            ../
          </button>
          {directories.map((directory) => (
            <button
              key={directory.name}
              type="button"
              onClick={() =>
                onNavigate(
                  hostPath(
                    root.hostId,
                    `${current.path.replace(/\/$/, '')}/${directory.name}`,
                  ),
                )
              }
            >
              {directory.name}/
            </button>
          ))}
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => void onSelect(current)}>
            Use this folder
          </button>
        </div>
      </section>
    </div>
  )
}

function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  onCancel: () => void,
  busy: boolean,
  initialFocus?: RefObject<HTMLElement | null>,
): void {
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(busy)
  onCancelRef.current = onCancel
  busyRef.current = busy
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      (initialFocus?.current ?? dialogRef.current)?.focus(),
    )
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busyRef.current) onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [dialogRef, initialFocus])
}
