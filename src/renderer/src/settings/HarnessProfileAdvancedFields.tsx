import type { ReactElement } from 'react'

import {
  hostPath,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessProfileExecutable,
  type HarnessProfileInput,
  type HostPath,
} from '../../../shared'
import { replaceHarnessValue } from './harness-profile-editor-policy'

export const HARNESS_ENVIRONMENT_STORAGE_GUIDANCE =
  'Literal values are stored and shown as plaintext. Reference-sourced values alone are redacted.'

export function HarnessProfileAdvancedFields({
  input,
  hostId,
  onUpdateInput,
  onAuthorizeExecutable,
  onPickBinding,
}: {
  readonly input: HarnessProfileInput
  readonly hostId: HostPath['hostId']
  readonly onUpdateInput: (
    update: (input: HarnessProfileInput) => HarnessProfileInput,
  ) => void
  readonly onAuthorizeExecutable: () => void
  readonly onPickBinding: (index: number) => void
}): ReactElement {
  return (
    <>
      <ExecutableEditor
        executable={input.executable}
        hostId={hostId}
        onChange={(executable) =>
          onUpdateInput((current) => ({ ...current, executable }))
        }
        onAuthorize={onAuthorizeExecutable}
      />
      <EnvironmentEditor
        bindings={input.environment}
        onChange={(environment) =>
          onUpdateInput((current) => ({ ...current, environment }))
        }
      />
      <PathBindingsEditor
        bindings={input.pathBindings}
        hostId={hostId}
        onChange={(pathBindings) =>
          onUpdateInput((current) => ({ ...current, pathBindings }))
        }
        onPick={onPickBinding}
      />
    </>
  )
}

function ExecutableEditor({
  executable,
  hostId,
  onChange,
  onAuthorize,
}: {
  readonly executable: HarnessProfileExecutable
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
            onChange={(event) =>
              onChange({
                kind: 'path',
                path: hostPath(hostId, event.currentTarget.value),
              })
            }
          />
          <button type="button" onClick={onAuthorize}>
            Authorize path
          </button>
        </>
      ) : null}
    </div>
  )
}

function EnvironmentEditor({
  bindings,
  onChange,
}: {
  readonly bindings: readonly HarnessEnvironmentBinding[]
  readonly onChange: (value: readonly HarnessEnvironmentBinding[]) => void
}): ReactElement {
  return (
    <div className="settings-profile-rows">
      <header>
        <strong>Environment</strong>
        <button
          type="button"
          onClick={() =>
            onChange([...bindings, { kind: 'literal', name: '', value: '' }])
          }
        >
          Add
        </button>
      </header>
      <small className="settings-profile-environment-guidance">
        {HARNESS_ENVIRONMENT_STORAGE_GUIDANCE}
      </small>
      {bindings.map((binding, index) => (
        <div className="settings-profile-row" key={index}>
          <input
            aria-label="Environment name"
            value={binding.name}
            placeholder="NAME"
            onChange={(event) =>
              onChange(
                replaceHarnessValue(bindings, index, {
                  ...binding,
                  name: event.currentTarget.value,
                }),
              )
            }
          />
          <select
            value={binding.kind}
            aria-label="Environment operation"
            onChange={(event) => {
              const kind = event.currentTarget.value
              const next: HarnessEnvironmentBinding =
                kind === 'unset'
                  ? { kind: 'unset', name: binding.name }
                  : kind === 'literal'
                    ? { kind: 'literal', name: binding.name, value: '' }
                    : {
                        kind: 'reference',
                        name: binding.name,
                        source: 'host',
                        sourceName: binding.name,
                      }
              onChange(replaceHarnessValue(bindings, index, next))
            }}
          >
            <option value="literal">Plaintext value</option>
            <option value="reference">Secret reference</option>
            <option value="unset">Unset</option>
          </select>
          {binding.kind === 'literal' ? (
            <input
              aria-label="Environment value"
              value={binding.value}
              onChange={(event) =>
                onChange(
                  replaceHarnessValue(bindings, index, {
                    ...binding,
                    value: event.currentTarget.value,
                  }),
                )
              }
            />
          ) : binding.kind === 'reference' ? (
            <>
              <select
                aria-label="Reference source"
                value={binding.source}
                onChange={(event) =>
                  onChange(
                    replaceHarnessValue(bindings, index, {
                      ...binding,
                      source: event.currentTarget.value as 'host' | 'local-forward',
                    }),
                  )
                }
              >
                <option value="host">Target host</option>
                <option value="local-forward">Forward local</option>
              </select>
              <input
                aria-label="Reference name"
                value={binding.sourceName}
                onChange={(event) =>
                  onChange(
                    replaceHarnessValue(bindings, index, {
                      ...binding,
                      sourceName: event.currentTarget.value,
                    }),
                  )
                }
              />
            </>
          ) : (
            <span />
          )}
          <button
            type="button"
            aria-label={`Remove ${binding.name || 'environment row'}`}
            onClick={() =>
              onChange(bindings.filter((_, candidate) => candidate !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function PathBindingsEditor({
  bindings,
  hostId,
  onChange,
  onPick,
}: {
  readonly bindings: readonly HarnessPathBinding[]
  readonly hostId: HostPath['hostId']
  readonly onChange: (value: readonly HarnessPathBinding[]) => void
  readonly onPick: (index: number) => void
}): ReactElement {
  return (
    <div className="settings-profile-rows">
      <header>
        <strong>Host path bindings</strong>
        <button
          type="button"
          onClick={() =>
            onChange([...bindings, { name: '', path: hostPath(hostId, '/') }])
          }
        >
          Add
        </button>
      </header>
      {bindings.map((binding, index) => (
        <div className="settings-profile-row path" key={index}>
          <input
            aria-label="Path binding name"
            value={binding.name}
            placeholder="monorepo"
            onChange={(event) =>
              onChange(
                replaceHarnessValue(bindings, index, {
                  ...binding,
                  name: event.currentTarget.value,
                }),
              )
            }
          />
          <code>{binding.path.path}</code>
          <button type="button" onClick={() => onPick(index)}>
            Choose on host…
          </button>
          <button
            type="button"
            aria-label={`Remove ${binding.name || 'path row'}`}
            onClick={() =>
              onChange(bindings.filter((_, candidate) => candidate !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
