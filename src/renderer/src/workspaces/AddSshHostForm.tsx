import type { ReactElement } from 'react'

import type { AddSshHostRequest } from '../../../shared/ssh-configuration'

export function AddSshHostForm({
  fields,
  busy,
  onChange,
  onSave,
  onCancel,
  onPickIdentity,
}: {
  readonly fields: AddSshHostRequest
  readonly busy: boolean
  readonly onChange: (fields: AddSshHostRequest) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly onPickIdentity: () => void
}): ReactElement {
  const field = (
    key: 'alias' | 'hostname' | 'username',
    label: string,
    autoFocus = false,
  ): ReactElement => (
    <label>
      <span>{label}</span>
      <input
        className="hvir-input hvir-control"
        aria-label={label}
        autoFocus={autoFocus}
        required
        disabled={busy}
        value={fields[key]}
        maxLength={255}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange({ ...fields, [key]: event.target.value })}
      />
    </label>
  )
  return (
    <form
      className="ssh-host-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      {field('alias', 'SSH alias', true)}
      {field('hostname', 'Hostname or IP address')}
      {field('username', 'Username')}
      <details>
        <summary tabIndex={0}>Connection options</summary>
        <label>
          <span>Port</span>
          <input
            className="hvir-input hvir-control"
            aria-label="Port"
            type="number"
            min={1}
            max={65535}
            required
            disabled={busy}
            value={Number.isNaN(fields.port) ? '' : fields.port}
            onChange={(event) =>
              onChange({ ...fields, port: event.target.valueAsNumber })
            }
          />
        </label>
        <div className="ssh-identity-picker">
          <span>Identity file (optional)</span>
          {fields.identityFile ? (
            <code>{fields.identityFile.path}</code>
          ) : (
            <small>Use existing authentication defaults</small>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onPickIdentity}
            className="hvir-button hvir-control"
          >
            Choose identity file…
          </button>
          {fields.identityFile ? (
            <button
              className="hvir-button hvir-control"
              type="button"
              disabled={busy}
              onClick={() => onChange({ ...fields, identityFile: undefined })}
            >
              Clear
            </button>
          ) : null}
        </div>
      </details>
      <div className="dialog-actions">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="hvir-button hvir-control"
        >
          Cancel
        </button>
        <button type="submit" disabled={busy} className="hvir-button hvir-control">
          {busy ? 'Saving…' : 'Add host'}
        </button>
      </div>
    </form>
  )
}
