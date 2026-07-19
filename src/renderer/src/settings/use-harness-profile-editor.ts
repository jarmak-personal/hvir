import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  HarnessCommandPreview,
  HarnessProfile,
  HarnessProfileId,
  HarnessProfileInput,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HarnessProviderId,
  HostPath,
} from '../../../shared'
import { parseHarnessArguments } from './harness-argument-editor'
import {
  applyExecutableGrant,
  applyPathBindingGrant,
  editorErrorMessage,
  findProfileProbe,
  mergeProfileProbe,
} from './harness-profile-editor-policy'
import {
  harnessProfileDraft,
  harnessProfileSaveRevision,
  isHarnessProfileDraftDirty,
  newHarnessProfileDraft,
  type HarnessProfileDraft,
} from './harness-profile-draft'
import { HarnessProfileRequestPolicy } from './harness-profile-request-policy'

export type HarnessPickerTarget = { readonly kind: 'binding'; readonly index: number }

export function useHarnessProfileEditor({
  workspaceRoot,
  projectRoot,
  initialAddOpen,
}: {
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialAddOpen: boolean
}) {
  const [providers, setProviders] = useState<readonly HarnessProviderDescriptor[]>([])
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [draft, setDraft] = useState<HarnessProfileDraft>()
  const [previews, setPreviews] = useState<readonly HarnessCommandPreview[]>([])
  const [previewError, setPreviewError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [picker, setPicker] = useState<HarnessPickerTarget>()
  const [profileProbes, setProfileProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [pendingProbeIds, setPendingProbeIds] = useState<ReadonlySet<HarnessProfileId>>(
    new Set(),
  )
  const [addOpen, setAddOpen] = useState(initialAddOpen)
  const [unsavedPromptOpen, setUnsavedPromptOpen] = useState(false)
  const pendingLeaveResolution = useRef<
    ((confirmed: boolean) => void) | undefined
  >(undefined)
  const policy = useRef(new HarnessProfileRequestPolicy())
  const stateRef = useRef({ workspaceRoot, projectRoot, providers, profiles, draft })
  const dirtyRef = useRef(false)
  stateRef.current = { workspaceRoot, projectRoot, providers, profiles, draft }
  const updateInput = useCallback(
    (update: (input: HarnessProfileInput) => HarnessProfileInput): void => {
      setDraft((current) =>
        current ? { ...current, input: update(current.input) } : current,
      )
      setError(undefined)
    },
    [],
  )

  const probeAvailability = useCallback(
    (launchProfiles: readonly HarnessProfile[], force = false): void => {
      const root = stateRef.current.workspaceRoot
      if (!root) return
      const candidates = launchProfiles.filter((profile) => !profile.builtIn)
      setPendingProbeIds(new Set(candidates.map(({ id }) => id)))
      for (const profile of candidates) {
        const token = policy.current.start(`probe:${profile.id}`)
        void window.hvir
          .invoke('harness:probe-profiles', {
            root,
            profileIds: [profile.id],
            force,
          })
          .then(([probe]) => {
            if (probe && policy.current.isCurrent(token)) {
              setProfileProbes((current) => mergeProfileProbe(current, probe))
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!policy.current.isCurrent(token)) return
            setPendingProbeIds((current) => {
              const next = new Set(current)
              next.delete(profile.id)
              return next
            })
          })
      }
    },
    [],
  )

  const refresh = useCallback(
    async (selectId?: HarnessProfile['id']): Promise<void> => {
      const current = stateRef.current
      if (!current.workspaceRoot) return
      const token = policy.current.start('load')
      let catalog: readonly HarnessProviderDescriptor[]
      let launchProfiles: readonly HarnessProfile[]
      try {
        const loaded = await Promise.all([
          window.hvir.invoke('harness:catalog', undefined),
          window.hvir.invoke('harness:profiles', { root: current.workspaceRoot }),
        ])
        catalog = loaded[0]
        launchProfiles = loaded[1]
      } catch (reason) {
        if (policy.current.isCurrent(token)) throw reason
        return
      }
      if (!policy.current.isCurrent(token)) return
      setProviders(catalog)
      setProfiles(launchProfiles)
      probeAvailability(launchProfiles)
      const selected =
        launchProfiles.find((profile) => profile.id === selectId) ??
        launchProfiles.find((profile) => profile.id === stateRef.current.draft?.id) ??
        launchProfiles[0]
      policy.current.switchProfile()
      setDraft(
        selected
          ? harnessProfileDraft(selected)
          : newHarnessProfileDraft(catalog, launchProfiles),
      )
    },
    [probeAvailability],
  )

  useEffect(() => {
    const policyOwner = policy.current
    policyOwner.switchWorkspace()
    setProviders([])
    setProfiles([])
    setDraft(undefined)
    setPreviews([])
    setPreviewError(undefined)
    setProfileProbes([])
    setPendingProbeIds(new Set())
    setBusy(false)
    setDeleteArmed(false)
    setError(undefined)
    if (!workspaceRoot) return
    const requestRoot = workspaceRoot
    void refresh().catch((reason: unknown) => {
      const activeRoot = stateRef.current.workspaceRoot
      if (
        activeRoot?.hostId === requestRoot.hostId &&
        activeRoot.path === requestRoot.path
      ) {
        setError(editorErrorMessage(reason))
      }
    })
    return () => {
      policyOwner.switchWorkspace()
    }
  }, [projectRoot, refresh, workspaceRoot])

  const serializedInput = useMemo(
    () => (draft ? JSON.stringify([draft.input, draft.argvText]) : ''),
    [draft],
  )
  useEffect(() => {
    if (!draft || !workspaceRoot) return
    const policyOwner = policy.current
    const token = policyOwner.start('preview')
    const timer = window.setTimeout(() => {
      let previewInput: HarnessProfileInput
      try {
        previewInput = { ...draft.input, args: parseHarnessArguments(draft.argvText) }
      } catch (reason) {
        if (!policyOwner.isCurrent(token, true)) return
        setPreviews([])
        setPreviewError(editorErrorMessage(reason))
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
          if (!policyOwner.isCurrent(token, true)) return
          setPreviews(values)
          setPreviewError(undefined)
        },
        (reason: unknown) => {
          if (!policyOwner.isCurrent(token, true)) return
          setPreviews([])
          setPreviewError(editorErrorMessage(reason))
        },
      )
    }, 180)
    return () => {
      window.clearTimeout(timer)
      policyOwner.invalidate('preview')
    }
  }, [draft, profiles, serializedInput, workspaceRoot])

  const selectedProfile = profiles.find((profile) => profile.id === draft?.id)
  const dirty = draft
    ? isHarnessProfileDraftDirty(selectedProfile, draft.input, draft.argvText)
    : false
  dirtyRef.current = dirty

  const confirmSafeToLeave = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true)
    pendingLeaveResolution.current?.(false)
    setUnsavedPromptOpen(true)
    return new Promise<boolean>((resolve) => {
      pendingLeaveResolution.current = resolve
    })
  }, [])

  const resolveUnsavedPrompt = useCallback((confirmed: boolean): void => {
    const resolve = pendingLeaveResolution.current
    pendingLeaveResolution.current = undefined
    setUnsavedPromptOpen(false)
    resolve?.(confirmed)
  }, [])

  useEffect(
    () => () => {
      pendingLeaveResolution.current?.(false)
      pendingLeaveResolution.current = undefined
    },
    [],
  )

  const runAfterDraftGuard = useCallback(
    (action: () => void): void => {
      void confirmSafeToLeave().then((confirmed) => {
        if (confirmed) action()
      })
    },
    [confirmSafeToLeave],
  )

  const save = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current
    if (!current.draft || !current.workspaceRoot || current.draft.builtIn) return false
    const token = policy.current.start('mutation')
    setBusy(true)
    setError(undefined)
    try {
      const revision = harnessProfileSaveRevision(current.draft)
      const profile = await window.hvir.invoke(
        'harness:profile-save',
        revision.kind === 'update'
          ? {
              root: current.workspaceRoot,
              id: revision.id,
              expectedLaunchRevision: revision.expectedLaunchRevision,
              expectedMetadataRevision: revision.expectedMetadataRevision,
              input: revision.input,
            }
          : { root: current.workspaceRoot, input: revision.input },
      )
      if (!policy.current.isCurrent(token)) return false
      await refresh(profile.id)
      if (!policy.current.isCurrent(token)) return false
      window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
      return true
    } catch (reason) {
      if (policy.current.isCurrent(token)) setError(editorErrorMessage(reason))
      return false
    } finally {
      if (policy.current.isCurrent(token)) setBusy(false)
    }
  }, [refresh])

  const duplicate = useCallback(async (): Promise<void> => {
    const id = stateRef.current.draft?.id
    if (!id) return
    const token = policy.current.start('mutation')
    setBusy(true)
    setError(undefined)
    try {
      const profile = await window.hvir.invoke('harness:profile-duplicate', { id })
      if (!policy.current.isCurrent(token)) return
      await refresh(profile.id)
      if (policy.current.isCurrent(token)) {
        window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
      }
    } catch (reason) {
      if (policy.current.isCurrent(token)) setError(editorErrorMessage(reason))
    } finally {
      if (policy.current.isCurrent(token)) setBusy(false)
    }
  }, [refresh])

  const remove = useCallback(async (): Promise<void> => {
    const current = stateRef.current.draft
    if (!current?.id || current.builtIn) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    const token = policy.current.start('mutation')
    setBusy(true)
    try {
      await window.hvir.invoke('harness:profile-delete', { id: current.id })
      if (!policy.current.isCurrent(token)) return
      setDeleteArmed(false)
      await refresh()
      if (policy.current.isCurrent(token)) {
        window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
      }
    } catch (reason) {
      if (policy.current.isCurrent(token)) setError(editorErrorMessage(reason))
    } finally {
      if (policy.current.isCurrent(token)) setBusy(false)
    }
  }, [deleteArmed, refresh])

  const selectProfile = useCallback(
    (profile: HarnessProfile): void => {
      if (stateRef.current.draft?.id === profile.id) return
      runAfterDraftGuard(() => {
        policy.current.switchProfile()
        setDraft(harnessProfileDraft(profile))
        setDeleteArmed(false)
      })
    },
    [runAfterDraftGuard],
  )

  const setArguments = useCallback(
    (argvText: string): void => {
      setDraft((current) => (current ? { ...current, argvText } : current))
      try {
        const args = parseHarnessArguments(argvText)
        updateInput((input) => ({ ...input, args }))
        setError(undefined)
      } catch (reason) {
        setError(editorErrorMessage(reason))
      }
    },
    [updateInput],
  )

  const authorizeExecutable = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const executable = current.draft?.input.executable
    if (!current.workspaceRoot || executable?.kind !== 'path') return
    const token = policy.current.start('grant:executable')
    try {
      const grant = await window.hvir.invoke('harness:authorize-path', {
        root: current.workspaceRoot,
        path: executable.path,
      })
      if (!policy.current.isCurrent(token, true)) return
      updateInput((input) => ({
        ...input,
        executable: applyExecutableGrant(input.executable, grant),
      }))
    } catch (reason) {
      if (policy.current.isCurrent(token, true)) {
        setError(editorErrorMessage(reason))
      }
    }
  }, [updateInput])

  const authorizeBinding = useCallback(
    async (path: HostPath): Promise<void> => {
      const current = stateRef.current
      const target = picker
      if (!current.workspaceRoot || !target) return
      const token = policy.current.start('grant:binding')
      try {
        const grant = await window.hvir.invoke('harness:authorize-path', {
          root: current.workspaceRoot,
          path,
        })
        if (!policy.current.isCurrent(token, true)) return
        updateInput((input) => applyPathBindingGrant(input, target.index, grant))
        setPicker(undefined)
      } catch (reason) {
        if (policy.current.isCurrent(token, true)) {
          setError(editorErrorMessage(reason))
        }
      }
    },
    [picker, updateInput],
  )

  const openPicker = useCallback((index: number): void => {
    policy.current.invalidate('grant:binding')
    setPicker({ kind: 'binding', index })
  }, [])

  const closePicker = useCallback((): void => {
    policy.current.invalidate('grant:binding')
    setPicker(undefined)
  }, [])

  const discardDraft = useCallback((): void => {
    const current = stateRef.current
    const restored =
      current.profiles.find((profile) => profile.id === current.draft?.id) ??
      current.profiles[0]
    policy.current.switchProfile()
    setDraft(restored ? harnessProfileDraft(restored) : undefined)
    setDeleteArmed(false)
    setError(undefined)
  }, [])

  const manualProfile = useCallback((providerId: HarnessProviderId): void => {
    const current = stateRef.current
    policy.current.switchProfile()
    setDraft(newHarnessProfileDraft(current.providers, current.profiles, providerId))
    setDeleteArmed(false)
    setAddOpen(false)
  }, [])

  const materialized = useCallback(
    async (created: readonly HarnessProfile[]): Promise<void> => {
      setAddOpen(false)
      await refresh(created.at(-1)?.id)
      window.dispatchEvent(new Event('hvir:harness-profiles-changed'))
    },
    [refresh],
  )

  const provider = providers.find((candidate) => candidate.id === draft?.input.providerId)
  const selectedProbe =
    selectedProfile && workspaceRoot
      ? findProfileProbe(profileProbes, selectedProfile, workspaceRoot.hostId)
      : undefined
  const providerProbe = selectedProbe?.providerId === provider?.id ? selectedProbe : undefined

  return {
    providers,
    profiles,
    draft,
    previews,
    previewError,
    busy,
    error,
    deleteArmed,
    picker,
    profileProbes,
    pendingProbeIds,
    addOpen,
    unsavedPromptOpen,
    selectedProfile,
    provider,
    providerProbe,
    dirty,
    confirmSafeToLeave,
    resolveUnsavedPrompt,
    runAfterDraftGuard,
    probeAvailability,
    updateInput,
    setArguments,
    save,
    duplicate,
    remove,
    selectProfile,
    authorizeExecutable,
    authorizeBinding,
    discardDraft,
    manualProfile,
    materialized,
    openPicker,
    closePicker,
    setAddOpen,
  }
}
