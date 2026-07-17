import { useEffect, useMemo, useState, type ReactElement } from 'react'

import {
  asHarnessProviderId,
  hostPath,
  unwrapOperation,
  type HarnessArgumentPart,
  type HarnessCommandPreview,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessProfile,
  type HarnessProfileArgument,
  type HarnessProfileExecutable,
  type HarnessProfileInput,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'

interface HarnessProfilesSettingsProps {
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
}

interface ProfileDraft {
  readonly id?: HarnessProfile['id']
  readonly launchRevision?: number
  readonly metadataRevision?: number
  readonly builtIn: boolean
  readonly input: HarnessProfileInput
  readonly argvText: string
}

type PickerTarget = { readonly kind: 'binding'; readonly index: number }

export function HarnessProfilesSettings({
  workspaceRoot,
  projectRoot,
}: HarnessProfilesSettingsProps): ReactElement {
  const [providers, setProviders] = useState<readonly HarnessProviderDescriptor[]>([])
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [draft, setDraft] = useState<ProfileDraft>()
  const [previews, setPreviews] = useState<readonly HarnessCommandPreview[]>([])
  const [previewError, setPreviewError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [picker, setPicker] = useState<PickerTarget>()

  const refresh = async (selectId?: HarnessProfile['id']): Promise<void> => {
    if (!workspaceRoot) return
    const [catalog, launchProfiles] = await Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root: workspaceRoot }),
    ])
    setProviders(catalog)
    setProfiles(launchProfiles)
    const selected =
      launchProfiles.find((profile) => profile.id === selectId) ??
      launchProfiles.find((profile) => profile.id === draft?.id) ??
      launchProfiles[0]
    setDraft(
      selected
        ? draftFromProfile(selected)
        : newDraft(catalog, launchProfiles, projectRoot),
    )
  }

  useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) return
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root: workspaceRoot }),
    ]).then(
      ([catalog, launchProfiles]) => {
        if (cancelled) return
        setProviders(catalog)
        setProfiles(launchProfiles)
        const selected = launchProfiles[0]
        setDraft(
          selected
            ? draftFromProfile(selected)
            : newDraft(catalog, launchProfiles, projectRoot),
        )
      },
      (reason: unknown) => {
        if (!cancelled) setError(message(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectRoot, workspaceRoot])

  const serializedInput = useMemo(
    () => (draft ? JSON.stringify([draft.input, draft.argvText]) : ''),
    [draft],
  )
  useEffect(() => {
    if (!draft || !workspaceRoot) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      let previewInput: HarnessProfileInput
      try {
        previewInput = { ...draft.input, args: parseArguments(draft.argvText) }
      } catch (reason) {
        setPreviews([])
        setPreviewError(message(reason))
        return
      }
      const common = {
        root: workspaceRoot,
        cwd: workspaceRoot,
        harnessSessionId: '00000000-0000-4000-8000-000000000000',
      } as const
      const requests = draft.builtIn
        ? (['fresh', 'resume'] as const).map((mode) =>
            window.hvir.invoke('harness:preview', {
              ...common,
              mode,
              profileId: draft.id!,
              launchRevision:
                profiles.find((profile) => profile.id === draft.id)?.launchRevision ?? 1,
            }),
          )
        : (['fresh', 'resume'] as const).map((mode) =>
            window.hvir.invoke('harness:preview', {
              ...common,
              mode,
              profileId: draft.id,
              input: previewInput,
            }),
          )
      void Promise.all(requests).then(
        (values) => {
          if (cancelled) return
          setPreviews(values)
          setPreviewError(undefined)
        },
        (reason: unknown) => {
          if (cancelled) return
          setPreviews([])
          setPreviewError(message(reason))
        },
      )
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft, profiles, serializedInput, workspaceRoot])

  const updateInput = (
    update: (input: HarnessProfileInput) => HarnessProfileInput,
  ): void => {
    setDraft((current) =>
      current ? { ...current, input: update(current.input) } : current,
    )
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    if (!draft || !workspaceRoot || draft.builtIn) return
    setBusy(true)
    setError(undefined)
    try {
      const input = { ...draft.input, args: parseArguments(draft.argvText) }
      if (
        draft.id &&
        (draft.launchRevision === undefined || draft.metadataRevision === undefined)
      ) {
        throw new Error('Harness profile revision is unavailable; reopen it')
      }
      const profile = await window.hvir.invoke(
        'harness:profile-save',
        draft.id
          ? {
              root: workspaceRoot,
              id: draft.id,
              expectedLaunchRevision: draft.launchRevision!,
              expectedMetadataRevision: draft.metadataRevision!,
              input,
            }
          : { root: workspaceRoot, input },
      )
      await refresh(profile.id)
      window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  const duplicate = async (): Promise<void> => {
    if (!draft?.id) return
    setBusy(true)
    setError(undefined)
    try {
      const profile = await window.hvir.invoke('harness:profile-duplicate', {
        id: draft.id,
      })
      await refresh(profile.id)
      window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id || draft.builtIn) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setBusy(true)
    try {
      await window.hvir.invoke('harness:profile-delete', { id: draft.id })
      setDeleteArmed(false)
      await refresh()
      window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!workspaceRoot || !projectRoot) {
    return (
      <p className="settings-harness-empty">Open a project to configure harnesses.</p>
    )
  }

  const provider = providers.find((candidate) => candidate.id === draft?.input.providerId)
  return (
    <section className="settings-harnesses" aria-labelledby="settings-harnesses-title">
      <header>
        <div>
          <h3 id="settings-harnesses-title" tabIndex={-1}>
            Harnesses
          </h3>
          <p>
            Launch profiles keep argv, environment, paths, and recovery identity
            structured.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || providers.length === 0}
          onClick={() => {
            setDraft(newDraft(providers, profiles, projectRoot))
            setDeleteArmed(false)
          }}
        >
          New profile
        </button>
      </header>
      <div className="settings-harness-layout">
        <nav className="settings-profile-list" aria-label="Harness profiles">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={draft?.id === profile.id ? 'active' : undefined}
              onClick={() => {
                setDraft(draftFromProfile(profile))
                setDeleteArmed(false)
              }}
            >
              <strong>{profile.displayName}</strong>
              <small>
                {providers.find((candidate) => candidate.id === profile.providerId)
                  ?.displayName ?? profile.providerId}
                {profile.risk === 'standard' ? '' : ` · ${riskLabel(profile.risk)}`}
              </small>
            </button>
          ))}
        </nav>
        {draft ? (
          <div className="settings-profile-editor">
            {draft.builtIn ? (
              <p className="settings-profile-note">
                Built-in defaults are immutable. Duplicate this profile to customize it.
              </p>
            ) : null}
            <div className="settings-profile-grid">
              <label>
                <span>Name</span>
                <input
                  value={draft.input.displayName}
                  disabled={draft.builtIn}
                  onChange={(event) =>
                    updateInput((input) => ({
                      ...input,
                      displayName: event.currentTarget.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>Provider</span>
                <select
                  value={draft.input.providerId}
                  disabled={draft.builtIn}
                  onChange={(event) => {
                    const providerId = asHarnessProviderId(event.currentTarget.value)
                    updateInput((input) => ({
                      ...input,
                      providerId,
                      executable:
                        providerId === 'custom'
                          ? { kind: 'command', command: '' }
                          : { kind: 'provider-default' },
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
                  onChange={(event) =>
                    updateInput((input) => ({
                      ...input,
                      description: event.currentTarget.value || undefined,
                    }))
                  }
                />
              </label>
              <label>
                <span>Scope</span>
                <select
                  value={draft.input.scope.kind}
                  disabled={draft.builtIn}
                  onChange={(event) =>
                    updateInput((input) => ({
                      ...input,
                      scope:
                        event.currentTarget.value === 'project'
                          ? { kind: 'project', projectRoot }
                          : { kind: 'global' },
                    }))
                  }
                >
                  <option value="global">All projects</option>
                  <option value="project">This registered project</option>
                </select>
              </label>
            </div>
            <ExecutableEditor
              executable={draft.input.executable}
              disabled={draft.builtIn}
              hostId={workspaceRoot.hostId}
              onChange={(executable) =>
                updateInput((input) => ({ ...input, executable }))
              }
              onAuthorize={() => {
                if (draft.input.executable.kind !== 'path') return
                void window.hvir
                  .invoke('harness:authorize-path', {
                    root: workspaceRoot,
                    path: draft.input.executable.path,
                  })
                  .then((grant) =>
                    updateInput((input) => ({
                      ...input,
                      executable: { kind: 'path', path: grant.path, grantId: grant.id },
                    })),
                  )
                  .catch((reason: unknown) => setError(message(reason)))
              }}
            />
            <label className="settings-profile-argv">
              <span>
                Arguments <small>one argv value per line</small>
              </span>
              <textarea
                spellCheck={false}
                disabled={draft.builtIn}
                value={draft.argvText}
                placeholder={'--add-dir\n{binding:monorepo}'}
                onChange={(event) => {
                  const argvText = event.currentTarget.value
                  setDraft((current) => (current ? { ...current, argvText } : current))
                  try {
                    const args = parseArguments(argvText)
                    updateInput((input) => ({ ...input, args }))
                    setError(undefined)
                  } catch (reason) {
                    setError(message(reason))
                  }
                }}
              />
            </label>
            {provider?.profileGuidance.reservedArguments.length ? (
              <p className="settings-profile-note">
                Provider-owned session tokens:{' '}
                {provider.profileGuidance.reservedArguments.join(', ')}. Use Custom if you
                need to own those semantics.
              </p>
            ) : null}
            <EnvironmentEditor
              bindings={draft.input.environment}
              disabled={draft.builtIn}
              onChange={(environment) =>
                updateInput((input) => ({ ...input, environment }))
              }
            />
            <PathBindingsEditor
              bindings={draft.input.pathBindings}
              disabled={draft.builtIn}
              hostId={workspaceRoot.hostId}
              onChange={(pathBindings) =>
                updateInput((input) => ({ ...input, pathBindings }))
              }
              onPick={(index) => setPicker({ kind: 'binding', index })}
            />
            <div className="settings-profile-risk">
              <strong>
                Risk: {previews[0] ? riskLabel(previews[0].risk) : 'Pending validation'}
              </strong>
              <small>
                Best-effort provider classification; it is a warning and restore policy,
                not a security boundary.
              </small>
            </div>
            <div className="settings-profile-previews">
              {previews.map((preview) => (
                <div key={preview.mode}>
                  <strong>
                    {preview.mode === 'fresh' ? 'Fresh launch' : 'Exact resume'}
                  </strong>
                  <code>{preview.command}</code>
                </div>
              ))}
              {previewError ? <p className="dialog-error">{previewError}</p> : null}
              <small>
                Literal values are stored and shown as plaintext. Reference-sourced values
                alone are redacted.
              </small>
            </div>
            {error ? <p className="dialog-error">{error}</p> : null}
            <div className="settings-profile-actions">
              <button
                type="button"
                disabled={busy || draft.builtIn || draft.input.order === 0}
                onClick={() =>
                  updateInput((input) => ({ ...input, order: input.order - 1 }))
                }
              >
                Move earlier
              </button>
              <button
                type="button"
                disabled={busy || draft.builtIn || draft.input.order >= 199}
                onClick={() =>
                  updateInput((input) => ({ ...input, order: input.order + 1 }))
                }
              >
                Move later
              </button>
              <button
                type="button"
                disabled={busy || !draft.id}
                onClick={() => void duplicate()}
              >
                Duplicate
              </button>
              <button
                type="button"
                disabled={busy || draft.builtIn || !draft.id}
                onClick={() => void remove()}
              >
                {deleteArmed ? 'Confirm delete' : 'Delete'}
              </button>
              <button
                type="button"
                disabled={busy || draft.builtIn}
                onClick={() => void save()}
              >
                Save profile
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {picker ? (
        <HarnessFolderPicker
          root={workspaceRoot}
          onCancel={() => setPicker(undefined)}
          onSelect={async (path) => {
            try {
              const grant = await window.hvir.invoke('harness:authorize-path', {
                root: workspaceRoot,
                path,
              })
              updateInput((input) => ({
                ...input,
                pathBindings: input.pathBindings.map((binding, index) =>
                  index === picker.index
                    ? { ...binding, path: grant.path, grantId: grant.id }
                    : binding,
                ),
              }))
              setPicker(undefined)
            } catch (reason) {
              setError(message(reason))
            }
          }}
        />
      ) : null}
    </section>
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
              onChange({
                kind: 'path',
                path: hostPath(hostId, event.currentTarget.value),
              })
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
          onClick={() =>
            onChange([...bindings, { kind: 'literal', name: '', value: '' }])
          }
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
                replaceAt(bindings, index, {
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
              onChange(replaceAt(bindings, index, next))
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
                  replaceAt(bindings, index, {
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
                    replaceAt(bindings, index, {
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
                    replaceAt(bindings, index, {
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
          onClick={() =>
            onChange([...bindings, { name: '', path: hostPath(hostId, '/') }])
          }
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
                replaceAt(bindings, index, {
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

function HarnessFolderPicker({
  root,
  onCancel,
  onSelect,
}: {
  readonly root: HostPath
  readonly onCancel: () => void
  readonly onSelect: (path: HostPath) => Promise<void>
}): ReactElement {
  const [current, setCurrent] = useState(root)
  const [directories, setDirectories] = useState<readonly { readonly name: string }[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    void window.hvir
      .invoke('project:browse-host', { hostId: root.hostId, path: current.path })
      .then((response) => {
        if (cancelled) return
        try {
          const listing = unwrapOperation(response)
          setCurrent(listing.path)
          setDirectories(listing.directories)
          setError(undefined)
        } catch (reason) {
          setError(message(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [current.path, root.hostId])
  const parent =
    current.path === '/' ? '/' : current.path.replace(/\/+[^/]+\/?$/, '') || '/'
  return (
    <div className="modal-backdrop nested">
      <section
        className="project-dialog harness-folder-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-folder-title"
      >
        <h3 id="harness-folder-title">Choose folder on {root.hostId}</h3>
        <code>{current.path}</code>
        <div className="harness-folder-list">
          <button
            type="button"
            disabled={current.path === '/'}
            onClick={() => setCurrent(hostPath(root.hostId, parent))}
          >
            ../
          </button>
          {directories.map((directory) => (
            <button
              key={directory.name}
              type="button"
              onClick={() =>
                setCurrent(
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

function draftFromProfile(profile: HarnessProfile): ProfileDraft {
  return {
    id: profile.id,
    launchRevision: profile.launchRevision,
    metadataRevision: profile.metadataRevision,
    builtIn: profile.builtIn,
    input: {
      displayName: profile.displayName,
      description: profile.description,
      providerId: profile.providerId,
      scope: profile.scope,
      executable: profile.executable,
      args: profile.args,
      environment: profile.environment,
      pathBindings: profile.pathBindings,
      order: profile.order,
    },
    argvText: serializeArguments(profile.args),
  }
}

function newDraft(
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  _projectRoot?: HostPath,
): ProfileDraft | undefined {
  const provider = providers.find((candidate) => candidate.default) ?? providers[0]
  if (!provider) return undefined
  return {
    builtIn: false,
    input: {
      displayName: `${provider.displayName} profile`,
      providerId: provider.id,
      scope: { kind: 'global' },
      executable: { kind: 'provider-default' },
      args: [],
      environment: [],
      pathBindings: [],
      order: Math.min(199, Math.max(0, ...profiles.map((profile) => profile.order + 1))),
    },
    argvText: '',
  }
}

function serializeArguments(args: readonly HarnessProfileArgument[]): string {
  return args
    .map((argument) => {
      const value = argument.parts.map(serializePart).join('')
      return value === '' ? "''" : value
    })
    .join('\n')
}

function serializePart(part: HarnessArgumentPart): string {
  if (part.kind === 'literal') return part.value
  if (part.source === 'projectRoot') return '{projectRoot}'
  if (part.source === 'workspaceRoot') return '{workspaceRoot}'
  return `{binding:${part.binding ?? ''}}`
}

function parseArguments(value: string): readonly HarnessProfileArgument[] {
  return value
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ({ parts: parseArgumentParts(line) }))
}

function parseArgumentParts(value: string): readonly HarnessArgumentPart[] {
  if (value === "''") return [{ kind: 'literal', value: '' }]
  const parts: HarnessArgumentPart[] = []
  const token = /\{(projectRoot|workspaceRoot|binding:([a-zA-Z][a-zA-Z0-9_-]{0,63}))\}/g
  let position = 0
  for (const match of value.matchAll(token)) {
    if (match.index > position)
      parts.push({ kind: 'literal', value: value.slice(position, match.index) })
    const name = match[1]
    parts.push(
      name === 'projectRoot'
        ? { kind: 'path', source: 'projectRoot' }
        : name === 'workspaceRoot'
          ? { kind: 'path', source: 'workspaceRoot' }
          : { kind: 'path', source: 'binding', binding: match[2] },
    )
    position = match.index + match[0].length
  }
  if (position < value.length)
    parts.push({ kind: 'literal', value: value.slice(position) })
  const unknown = parts
    .filter((part) => part.kind === 'literal')
    .map((part) => part.value)
    .join('')
    .match(/\{[^{}]+\}/)
  if (unknown) throw new Error(`Unknown path token '${unknown[0]}'`)
  return parts.length ? parts : [{ kind: 'literal', value: '' }]
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  )
}

function riskLabel(value: HarnessProfile['risk']): string {
  return value === 'standard'
    ? 'Standard'
    : value === 'elevated'
      ? 'Elevated'
      : 'Unclassified'
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
