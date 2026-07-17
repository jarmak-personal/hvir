import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'

import {
  asHarnessProviderId,
  hostPath,
  unwrapOperation,
  type HarnessCommandPreview,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessProfile,
  type HarnessProfileExecutable,
  type HarnessProfileInput,
  type HarnessProfileId,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HostPath,
} from '../../../shared'
import {
  parseHarnessArguments,
  serializeHarnessArguments,
} from './harness-argument-editor'

interface HarnessProfilesSettingsProps {
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialAddOpen?: boolean
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
  initialAddOpen = false,
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
  const [profileProbes, setProfileProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [pendingProbeIds, setPendingProbeIds] = useState<ReadonlySet<HarnessProfileId>>(
    new Set(),
  )
  const [addOpen, setAddOpen] = useState(initialAddOpen)
  const workspaceKey = workspaceRoot
    ? `${workspaceRoot.hostId}\u0000${workspaceRoot.path}`
    : ''
  const workspaceKeyRef = useRef(workspaceKey)
  workspaceKeyRef.current = workspaceKey

  const probeAvailability = useCallback(
    (launchProfiles: readonly HarnessProfile[], force = false): void => {
      if (!workspaceRoot) return
      const requestedWorkspaceKey = `${workspaceRoot.hostId}\u0000${workspaceRoot.path}`
      const candidates = launchProfiles.filter((profile) => !profile.builtIn)
      setPendingProbeIds(new Set(candidates.map(({ id }) => id)))
      for (const profile of candidates) {
        void window.hvir
          .invoke('harness:probe-profiles', {
            root: workspaceRoot,
            profileIds: [profile.id],
            force,
          })
          .then(([probe]) => {
            if (probe && workspaceKeyRef.current === requestedWorkspaceKey) {
              setProfileProbes((current) => mergeProbe(current, probe))
            }
          })
          .catch(() => undefined)
          .finally(() =>
            setPendingProbeIds((current) => {
              if (workspaceKeyRef.current !== requestedWorkspaceKey) return current
              const next = new Set(current)
              next.delete(profile.id)
              return next
            }),
          )
      }
    },
    [workspaceRoot],
  )

  const refresh = async (selectId?: HarnessProfile['id']): Promise<void> => {
    if (!workspaceRoot) return
    const [catalog, launchProfiles] = await Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root: workspaceRoot }),
    ])
    setProviders(catalog)
    setProfiles(launchProfiles)
    probeAvailability(launchProfiles)
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
    setProfileProbes([])
    setPendingProbeIds(new Set())
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root: workspaceRoot }),
    ]).then(
      ([catalog, launchProfiles]) => {
        if (cancelled) return
        setProviders(catalog)
        setProfiles(launchProfiles)
        probeAvailability(launchProfiles)
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
  }, [probeAvailability, projectRoot, workspaceRoot])

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
        previewInput = {
          ...draft.input,
          args: parseHarnessArguments(draft.argvText),
        }
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
      const input = {
        ...draft.input,
        args: parseHarnessArguments(draft.argvText),
      }
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
  const selectedProfile = profiles.find((profile) => profile.id === draft?.id)
  const selectedProbe = selectedProfile
    ? profileProbe(profileProbes, selectedProfile, workspaceRoot.hostId)
    : undefined
  const providerProbe =
    selectedProbe?.providerId === provider?.id ? selectedProbe : undefined
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
        <div className="settings-harness-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => probeAvailability(profiles, true)}
          >
            Refresh availability
          </button>
          <button
            type="button"
            disabled={busy || providers.length === 0}
            onClick={() => setAddOpen(true)}
          >
            Add a harness…
          </button>
        </div>
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
                {' · '}
                {profile.builtIn
                  ? 'Always available'
                  : pendingProbeIds.has(profile.id)
                    ? 'Checking…'
                    : settingsProbeLabel(
                        profileProbe(profileProbes, profile, workspaceRoot.hostId),
                      )}
              </small>
            </button>
          ))}
        </nav>
        {draft ? (
          <div className="settings-profile-editor">
            {draft.builtIn ? (
              <p className="settings-profile-note">
                Bare Shell is permanent and immutable. Duplicate it to create an
                additional named shell profile.
              </p>
            ) : null}
            <div className="settings-profile-grid">
              <label>
                <span>Name</span>
                <input
                  value={draft.input.displayName}
                  disabled={draft.builtIn}
                  onChange={(event) => {
                    const displayName = event.currentTarget.value
                    updateInput((input) => ({
                      ...input,
                      displayName,
                    }))
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
                    updateInput((input) => ({
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
                    updateInput((input) => ({
                      ...input,
                      description,
                    }))
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
                    updateInput((input) => ({
                      ...input,
                      scope,
                    }))
                  }}
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
                Arguments <small>spaces or newlines separate values</small>
              </span>
              <textarea
                aria-describedby="harness-arguments-help"
                spellCheck={false}
                disabled={draft.builtIn}
                value={draft.argvText}
                placeholder="--add-dir {binding:monorepo}"
                onChange={(event) => {
                  const argvText = event.currentTarget.value
                  setDraft((current) => (current ? { ...current, argvText } : current))
                  try {
                    const args = parseHarnessArguments(argvText)
                    updateInput((input) => ({ ...input, args }))
                    setError(undefined)
                  } catch (reason) {
                    setError(message(reason))
                  }
                }}
              />
              <small id="harness-arguments-help">
                Shell-style quoting only; no expansion or command execution. Parsed as{' '}
                {draft.input.args.length} argv values. The launch preview below is exact.
              </small>
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
            <div className="settings-profile-capabilities">
              <strong>Host capabilities</strong>
              <small>{detailedCapabilityLabel(provider, providerProbe)}</small>
            </div>
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
      {addOpen ? (
        <AddHarnessDialog
          providers={providers}
          root={workspaceRoot}
          onCancel={() => setAddOpen(false)}
          onMaterialized={async (created) => {
            setAddOpen(false)
            await refresh(created.at(-1)?.id)
            window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
          }}
          onManual={(providerId) => {
            setDraft(newDraft(providers, profiles, projectRoot, providerId))
            setDeleteArmed(false)
            setAddOpen(false)
          }}
        />
      ) : null}
    </section>
  )
}

function AddHarnessDialog({
  providers,
  root,
  onCancel,
  onMaterialized,
  onManual,
}: {
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly root: HostPath
  readonly onCancel: () => void
  readonly onMaterialized: (profiles: readonly HarnessProfile[]) => Promise<void>
  readonly onManual: (providerId: HarnessProviderId) => void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(false)
  const [generation, setGeneration] = useState(0)
  const [pending, setPending] = useState<ReadonlySet<HarnessProviderId>>(new Set())
  const [probes, setProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [selected, setSelected] = useState<ReadonlySet<HarnessProviderId>>(new Set())
  const [manualProviderId, setManualProviderId] = useState<HarnessProviderId>(
    () =>
      providers.find(({ profileTemplate }) => !profileTemplate)?.id ??
      providers.find(({ default: isDefault }) => isDefault)?.id ??
      providers[0]!.id,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const templates = useMemo(
    () => providers.filter((provider) => provider.profileTemplate && !provider.default),
    [providers],
  )
  onCancelRef.current = onCancel
  busyRef.current = busy

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
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
  }, [])

  useEffect(() => {
    let cancelled = false
    setProbes([])
    setSelected(new Set())
    setPending(new Set(templates.map(({ id }) => id)))
    for (const provider of templates) {
      void window.hvir
        .invoke('harness:probe-templates', {
          root,
          providerIds: [provider.id],
          force: generation > 0,
        })
        .then(([probe]) => {
          if (cancelled || !probe) return
          setProbes((current) => mergeProbe(current, probe))
        })
        .catch(() => undefined)
        .finally(() => {
          if (cancelled) return
          setPending((current) => {
            const next = new Set(current)
            next.delete(provider.id)
            return next
          })
        })
    }
    return () => {
      cancelled = true
    }
  }, [generation, root, templates])

  const detected = templates.filter((provider) => {
    const probe = probes.find((candidate) => candidate.providerId === provider.id)
    return pending.has(provider.id) || probe?.status === 'available'
  })

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
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh
          </button>
        </div>
        <div className="add-harness-candidates" aria-live="polite">
          {detected.map((provider) => {
            const checking = pending.has(provider.id)
            return (
              <label key={provider.id}>
                <input
                  type="checkbox"
                  disabled={checking || busy}
                  checked={selected.has(provider.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(provider.id)
                      else next.delete(provider.id)
                      return next
                    })
                  }}
                />
                <span>
                  <strong>{provider.profileTemplate?.displayName}</strong>
                  <small>{checking ? 'Checking…' : 'Installed on this host'}</small>
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
              value={manualProviderId}
              disabled={busy}
              onChange={(event) =>
                setManualProviderId(event.currentTarget.value as HarnessProviderId)
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
            disabled={busy}
            onClick={() => onManual(manualProviderId)}
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
            onClick={() => {
              setBusy(true)
              setError(undefined)
              void window.hvir
                .invoke('harness:profile-materialize', {
                  root,
                  providerIds: [...selected],
                })
                .then(onMaterialized)
                .catch((reason: unknown) => setError(message(reason)))
                .finally(() => setBusy(false))
            }}
          >
            Add selected
          </button>
        </div>
      </section>
    </div>
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
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const [current, setCurrent] = useState(root)
  const [directories, setDirectories] = useState<readonly { readonly name: string }[]>([])
  const [error, setError] = useState<string>()
  onCancelRef.current = onCancel
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled)',
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
  }, [])
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
    argvText: serializeHarnessArguments(profile.args),
  }
}

function newDraft(
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  _projectRoot?: HostPath,
  preferredProviderId?: HarnessProviderId,
): ProfileDraft | undefined {
  const provider =
    providers.find((candidate) => candidate.id === preferredProviderId) ??
    providers.find((candidate) => candidate.default) ??
    providers[0]
  if (!provider) return undefined
  return {
    builtIn: false,
    input: {
      displayName: provider.default
        ? 'Additional shell'
        : !provider.profileTemplate
          ? 'Custom command'
          : `${provider.displayName} profile`,
      providerId: provider.id,
      scope: { kind: 'global' },
      executable: provider.profileTemplate
        ? { kind: 'provider-default' }
        : { kind: 'command', command: '' },
      args: [],
      environment: [],
      pathBindings: [],
      order: Math.min(199, Math.max(0, ...profiles.map((profile) => profile.order + 1))),
    },
    argvText: '',
  }
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

function profileProbe(
  probes: readonly HarnessProfileProbe[],
  profile: HarnessProfile,
  hostId?: HostPath['hostId'],
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.profileId === profile.id &&
      probe.launchRevision === profile.launchRevision &&
      (hostId === undefined || probe.hostId === hostId),
  )
}

function mergeProbe(
  probes: readonly HarnessProfileProbe[],
  next: HarnessProfileProbe,
): readonly HarnessProfileProbe[] {
  return [
    ...probes.filter(
      (probe) =>
        probe.profileId !== next.profileId ||
        probe.launchRevision !== next.launchRevision ||
        probe.hostId !== next.hostId,
    ),
    next,
  ]
}

function settingsProbeLabel(probe: HarnessProfileProbe | undefined): string {
  if (!probe) return 'Not checked'
  switch (probe.status) {
    case 'available':
      return probe.version ?? 'Available'
    case 'executable-missing':
      return 'Executable missing on this host'
    case 'version-unsupported':
      return 'Version incompatible on this host'
    case 'capability-absent':
      return 'Required capability unavailable'
    case 'authentication-required':
      return 'Authentication required'
    case 'disconnected':
      return 'Host disconnected'
    case 'timeout':
      return 'Availability check timed out'
    case 'malformed-output':
      return 'Version output not understood'
    case 'probe-failed':
      return probe.detail ?? 'Availability check failed'
    case 'unchecked':
      return 'Not checked'
  }
}

function detailedCapabilityLabel(
  provider: HarnessProviderDescriptor | undefined,
  probe: HarnessProfileProbe | undefined,
): string {
  if (!provider) return 'Provider unavailable'
  if (provider.default) {
    return 'Plain terminal lifecycle; harness integration is inapplicable'
  }
  const capabilities = probe?.capabilities ?? provider.capabilities
  return [
    capabilities.exactResume ? 'Exact recovery' : 'No exact recovery',
    capabilities.contextPresentation === 'none'
      ? 'No structured telemetry'
      : capabilities.contextPresentation === 'pressure'
        ? 'Structured context pressure'
        : 'Structured context usage',
    settingsProbeLabel(probe),
  ].join(' · ')
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
