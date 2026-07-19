import type { ReactElement } from 'react'

import {
  hostPath,
  type HarnessProfileExecutable,
  type HarnessProfileInput,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'
import type { HarnessProfileDraft } from './harness-profile-draft'

export function HarnessProfileCommandFields({
  draft,
  provider,
  hostId,
  onUpdateInput,
  onArguments,
  onAuthorizeExecutable,
}: {
  readonly draft: HarnessProfileDraft
  readonly provider?: HarnessProviderDescriptor
  readonly hostId: HostPath['hostId']
  readonly onUpdateInput: (
    update: (input: HarnessProfileInput) => HarnessProfileInput,
  ) => void
  readonly onArguments: (value: string) => void
  readonly onAuthorizeExecutable: () => void
}): ReactElement {
  return (
    <>
      <ExecutableEditor
        executable={draft.input.executable}
        disabled={draft.builtIn}
        hostId={hostId}
        onChange={(executable) =>
          onUpdateInput((input) => ({ ...input, executable }))
        }
        onAuthorize={onAuthorizeExecutable}
      />
      <label className="settings-profile-argv">
        <span>
          Arguments <small>spaces or newlines separate values</small>
        </span>
        <textarea
          aria-describedby="harness-arguments-help"
          spellCheck={false}
          disabled={draft.builtIn}
          value={draft.argvText}
          placeholder="--add-dir {binding:monorepo}"
          onChange={(event) => onArguments(event.currentTarget.value)}
        />
        <small id="harness-arguments-help">
          Shell-style quoting only; no expansion or command execution. Parsed as{' '}
          {draft.input.args.length} argv values. The launch preview below is exact.
        </small>
      </label>
      {provider?.profileGuidance.reservedArguments.length ? (
        <p className="settings-profile-note">
          Provider-owned session tokens:{' '}
          {provider.profileGuidance.reservedArguments.join(', ')}. Use Custom if you need
          to own those semantics.
        </p>
      ) : null}
    </>
  )
}

function ExecutableEditor({
  executable,
  disabled,
  hostId,
  onChange,
  onAuthorize,
}: {
  readonly executable: HarnessProfileExecutable
  readonly disabled: boolean
  readonly hostId: HostPath['hostId']
  readonly onChange: (value: HarnessProfileExecutable) => void
  readonly onAuthorize: () => void
}): ReactElement {
  return (
    <div className="settings-profile-executable">
      <label>
        <span>Executable</span>
        <select
          value={executable.kind}
          disabled={disabled}
          onChange={(event) => {
            const kind = event.currentTarget.value
            onChange(
              kind === 'provider-default'
                ? { kind: 'provider-default' }
                : kind === 'command'
                  ? { kind: 'command', command: '' }
                  : { kind: 'path', path: hostPath(hostId, '/') },
            )
          }}
        >
          <option value="provider-default">Provider default</option>
          <option value="command">Command on PATH</option>
          <option value="path">Absolute host path</option>
        </select>
      </label>
      {executable.kind === 'command' ? (
        <input
          aria-label="Executable command"
          value={executable.command}
          disabled={disabled}
          placeholder="claude"
          onChange={(event) =>
            onChange({ kind: 'command', command: event.currentTarget.value })
          }
        />
      ) : executable.kind === 'path' ? (
        <>
          <input
            aria-label="Absolute executable path"
            value={executable.path.path}
            disabled={disabled}
            onChange={(event) =>
              onChange({ kind: 'path', path: hostPath(hostId, event.currentTarget.value) })
            }
          />
          <button type="button" disabled={disabled} onClick={onAuthorize}>
            Authorize path
          </button>
        </>
      ) : null}
    </div>
  )
}
