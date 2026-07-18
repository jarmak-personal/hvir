import type { ReactElement } from 'react'

import {
  asHarnessProviderId,
  hostPath,
  type HarnessCommandPreview,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessProfileInput,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'
import {
  harnessCapabilityLabel,
  previewRiskLabel,
  replaceHarnessValue,
} from './harness-profile-editor-policy'
import type { HarnessProfileDraft } from './harness-profile-draft'
import { HarnessProfileCommandFields } from './HarnessProfileCommandFields'

interface HarnessProfileEditorProps {
  readonly draft: HarnessProfileDraft
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly provider?: HarnessProviderDescriptor
  readonly providerProbe?: HarnessProfileProbe
  readonly previews: readonly HarnessCommandPreview[]
  readonly previewError?: string
  readonly error?: string
  readonly busy: boolean
  readonly dirty: boolean
  readonly deleteArmed: boolean
  readonly workspaceRoot: HostPath
  readonly projectRoot: HostPath
  readonly onUpdateInput: (
    update: (input: HarnessProfileInput) => HarnessProfileInput,
  ) => void
  readonly onArguments: (value: string) => void
  readonly onAuthorizeExecutable: () => void
  readonly onPickBinding: (index: number) => void
  readonly onDuplicate: () => void
  readonly onRemove: () => void
  readonly onSave: () => void
}

export function HarnessProfileEditor({
  draft,
  providers,
  provider,
  providerProbe,
  previews,
  previewError,
  error,
  busy,
  dirty,
  deleteArmed,
  workspaceRoot,
  projectRoot,
  onUpdateInput,
  onArguments,
  onAuthorizeExecutable,
  onPickBinding,
  onDuplicate,
  onRemove,
  onSave,
}: HarnessProfileEditorProps): ReactElement {
  return (
    <div className="settings-profile-editor">
      {draft.builtIn ? (
        <p className="settings-profile-note">
          Bare Shell is permanent and immutable. Duplicate it to create an additional
          named shell profile.
        </p>
      ) : null}
      <ProfileIdentityFields
        draft={draft}
        providers={providers}
        projectRoot={projectRoot}
        onUpdateInput={onUpdateInput}
      />
      <HarnessProfileCommandFields
        draft={draft}
        provider={provider}
        hostId={workspaceRoot.hostId}
        onUpdateInput={onUpdateInput}
        onArguments={onArguments}
        onAuthorizeExecutable={onAuthorizeExecutable}
      />
      <EnvironmentEditor
        bindings={draft.input.environment}
        disabled={draft.builtIn}
        onChange={(environment) =>
          onUpdateInput((input) => ({ ...input, environment }))
        }
      />
      <PathBindingsEditor
        bindings={draft.input.pathBindings}
        disabled={draft.builtIn}
        hostId={workspaceRoot.hostId}
        onChange={(pathBindings) =>
          onUpdateInput((input) => ({ ...input, pathBindings }))
        }
        onPick={onPickBinding}
      />
      <ProfileStatus
        provider={provider}
        probe={providerProbe}
        previews={previews}
        previewError={previewError}
      />
      {error ? <p className="dialog-error">{error}</p> : null}
      <ProfileActions
        draft={draft}
        busy={busy}
        dirty={dirty}
        deleteArmed={deleteArmed}
        onUpdateInput={onUpdateInput}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onSave={onSave}
      />
    </div>
  )
}

function ProfileIdentityFields({
  draft,
  providers,
  projectRoot,
  onUpdateInput,
}: Pick<
  HarnessProfileEditorProps,
  'draft' | 'providers' | 'projectRoot' | 'onUpdateInput'
>): ReactElement {
  return (
    <div className="settings-profile-grid">
      <label>
        <span>Name</span>
        <input
          value={draft.input.displayName}
          disabled={draft.builtIn}
          onChange={(event) => {
            const displayName = event.currentTarget.value
            onUpdateInput((input) => ({ ...input, displayName }))
          }}
        />
      </label>
      <label>
        <span>Provider</span>
        <select
          value={draft.input.providerId}
          disabled={draft.builtIn}
          onChange={(event) => {
            const providerId = asHarnessProviderId(event.currentTarget.value)
            const selectedProvider = providers.find(
              (candidate) => candidate.id === providerId,
            )
            onUpdateInput((input) => ({
              ...input,
              providerId,
              executable: selectedProvider?.profileTemplate
                ? { kind: 'provider-default' }
                : { kind: 'command', command: '' },
            }))
          }}
        >
          {providers.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-profile-description">
        <span>Description</span>
        <input
          value={draft.input.description ?? ''}
          disabled={draft.builtIn}
          onChange={(event) => {
            const description = event.currentTarget.value || undefined
            onUpdateInput((input) => ({ ...input, description }))
          }}
        />
      </label>
      <label>
        <span>Scope</span>
        <select
          value={draft.input.scope.kind}
          disabled={draft.builtIn}
          onChange={(event) => {
            const scope =
              event.currentTarget.value === 'project'
                ? ({ kind: 'project', projectRoot } as const)
                : ({ kind: 'global' } as const)
            onUpdateInput((input) => ({ ...input, scope }))
          }}
        >
          <option value="global">All projects</option>
          <option value="project">This registered project</option>
        </select>
      </label>
    </div>
  )
}

function EnvironmentEditor({
  bindings,
  disabled,
  onChange,
}: {
  readonly bindings: readonly HarnessEnvironmentBinding[]
  readonly disabled: boolean
  readonly onChange: (value: readonly HarnessEnvironmentBinding[]) => void
}): ReactElement {
  return (
    <div className="settings-profile-rows">
      <header>
        <strong>Environment</strong>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...bindings, { kind: 'literal', name: '', value: '' }])}
        >
          Add
        </button>
      </header>
      {bindings.map((binding, index) => (
        <div className="settings-profile-row" key={`${index}-${binding.name}`}>
          <input
            aria-label="Environment name"
            disabled={disabled}
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
            disabled={disabled}
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
              disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
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
            disabled={disabled}
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
  disabled,
  hostId,
  onChange,
  onPick,
}: {
  readonly bindings: readonly HarnessPathBinding[]
  readonly disabled: boolean
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
          disabled={disabled}
          onClick={() => onChange([...bindings, { name: '', path: hostPath(hostId, '/') }])}
        >
          Add
        </button>
      </header>
      {bindings.map((binding, index) => (
        <div className="settings-profile-row path" key={`${index}-${binding.name}`}>
          <input
            aria-label="Path binding name"
            disabled={disabled}
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
          <button type="button" disabled={disabled} onClick={() => onPick(index)}>
            Choose on host…
          </button>
          <button
            type="button"
            disabled={disabled}
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

function ProfileStatus({
  provider,
  probe,
  previews,
  previewError,
}: {
  readonly provider?: HarnessProviderDescriptor
  readonly probe?: HarnessProfileProbe
  readonly previews: readonly HarnessCommandPreview[]
  readonly previewError?: string
}): ReactElement {
  return (
    <>
      <div className="settings-profile-capabilities">
        <strong>Host capabilities</strong>
        <small>{harnessCapabilityLabel(provider, probe)}</small>
      </div>
      <div className="settings-profile-risk">
        <strong>Risk: {previewRiskLabel(previews)}</strong>
        <small>
          Best-effort provider classification; it is a warning and restore policy, not a
          security boundary.
        </small>
      </div>
      <div className="settings-profile-previews">
        {previews.map((preview) => (
          <div key={preview.mode}>
            <strong>{preview.mode === 'fresh' ? 'Fresh launch' : 'Exact resume'}</strong>
            <code>{preview.command}</code>
          </div>
        ))}
        {previewError ? <p className="dialog-error">{previewError}</p> : null}
        <small>
          Literal values are stored and shown as plaintext. Reference-sourced values
          alone are redacted.
        </small>
      </div>
    </>
  )
}

function ProfileActions({
  draft,
  busy,
  dirty,
  deleteArmed,
  onUpdateInput,
  onDuplicate,
  onRemove,
  onSave,
}: Pick<
  HarnessProfileEditorProps,
  | 'draft'
  | 'busy'
  | 'dirty'
  | 'deleteArmed'
  | 'onUpdateInput'
  | 'onDuplicate'
  | 'onRemove'
  | 'onSave'
>): ReactElement {
  return (
    <div className="settings-profile-actions">
      {dirty && !draft.builtIn ? (
        <span className="settings-profile-unsaved" role="status">
          Unsaved changes
        </span>
      ) : null}
      <button
        type="button"
        disabled={busy || draft.builtIn || draft.input.order === 0}
        onClick={() => onUpdateInput((input) => ({ ...input, order: input.order - 1 }))}
      >
        Move earlier
      </button>
      <button
        type="button"
        disabled={busy || draft.builtIn || draft.input.order >= 199}
        onClick={() => onUpdateInput((input) => ({ ...input, order: input.order + 1 }))}
      >
        Move later
      </button>
      <button type="button" disabled={busy || !draft.id} onClick={onDuplicate}>
        Duplicate
      </button>
      <button
        type="button"
        disabled={busy || draft.builtIn || !draft.id}
        onClick={onRemove}
      >
        {deleteArmed ? 'Confirm delete' : 'Delete'}
      </button>
      <button
        type="button"
        disabled={busy || draft.builtIn || !dirty}
        onClick={onSave}
      >
        Save harness profile
      </button>
    </div>
  )
}
