import type { ReactElement } from 'react'

import {
  asHarnessProviderId,
  type HarnessCommandPreview,
  type HarnessProfileInput,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'
import { harnessCapabilityLabel } from './harness-profile-editor-policy'
import type { HarnessProfileDraft } from './harness-profile-draft'
import {
  HARNESS_ENVIRONMENT_STORAGE_GUIDANCE,
  HarnessProfileAdvancedFields,
} from './HarnessProfileAdvancedFields'
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
    <div className="settings-profile-editor-shell">
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
      <div className="settings-profile-editor">
        <ProfileIdentityFields
          draft={draft}
          providers={providers}
          projectRoot={projectRoot}
          onUpdateInput={onUpdateInput}
        />
        <HarnessProfileCommandFields
          draft={draft}
          provider={provider}
          onArguments={onArguments}
        />
        <details className="settings-profile-disclosure">
          <summary>
            <span>Advanced</span>
            <small>Executable, environment, paths, and capabilities</small>
          </summary>
          <div className="settings-profile-disclosure-body">
            <HarnessProfileAdvancedFields
              input={draft.input}
              hostId={workspaceRoot.hostId}
              onUpdateInput={onUpdateInput}
              onAuthorizeExecutable={onAuthorizeExecutable}
              onPickBinding={onPickBinding}
            />
            <div className="settings-profile-capabilities">
              <strong>Host capabilities</strong>
              <small>{harnessCapabilityLabel(provider, providerProbe)}</small>
            </div>
          </div>
        </details>
        <details className="settings-profile-disclosure settings-profile-preview-disclosure">
          <summary>
            <span>Exact command preview</span>
            <small
              className={previewError ? 'settings-profile-disclosure-error' : undefined}
            >
              {previewError
                ? `Needs attention: ${previewError}`
                : `Fresh launch${provider?.capabilities.exactResume ? ' and resume' : ''}`}
            </small>
          </summary>
          <div className="settings-profile-disclosure-body">
            <ProfilePreviews previews={previews} previewError={previewError} />
          </div>
        </details>
        {error ? <p className="dialog-error">{error}</p> : null}
      </div>
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
    </div>
  )
}

function ProfilePreviews({
  previews,
  previewError,
}: {
  readonly previews: readonly HarnessCommandPreview[]
  readonly previewError?: string
}): ReactElement {
  return (
    <div className="settings-profile-previews">
      {previews.map((preview) => (
        <div key={preview.mode}>
          <strong>{preview.mode === 'fresh' ? 'Fresh launch' : 'Exact resume'}</strong>
          <code>{preview.command}</code>
        </div>
      ))}
      {previewError ? <p className="dialog-error">{previewError}</p> : null}
      <small>{HARNESS_ENVIRONMENT_STORAGE_GUIDANCE}</small>
    </div>
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
      {dirty ? (
        <span className="settings-profile-unsaved" role="status">
          Unsaved changes
        </span>
      ) : null}
      <button
        type="button"
        disabled={busy || draft.input.order === 0}
        aria-label="Move profile earlier"
        title="Move earlier"
        onClick={() => onUpdateInput((input) => ({ ...input, order: input.order - 1 }))}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={busy || draft.input.order >= 199}
        aria-label="Move profile later"
        title="Move later"
        onClick={() => onUpdateInput((input) => ({ ...input, order: input.order + 1 }))}
      >
        ↓
      </button>
      <button type="button" disabled={busy || !draft.id} onClick={onDuplicate}>
        Duplicate
      </button>
      <button type="button" disabled={busy || !draft.id} onClick={onRemove}>
        {deleteArmed ? 'Confirm delete' : 'Delete'}
      </button>
      <button
        type="button"
        className="primary"
        disabled={busy || !dirty}
        onClick={onSave}
      >
        Save harness profile
      </button>
    </div>
  )
}
