import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HarnessProviderId,
  HostPath,
} from '../../../shared'
import {
  editorErrorMessage,
  mergeProfileProbe,
} from './harness-profile-editor-policy'
import { HarnessProfileRequestPolicy } from './harness-profile-request-policy'

export function useAddHarnessDialog({
  open,
  providers,
  profiles,
  root,
  onMaterialized,
}: {
  readonly open: boolean
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly root: HostPath
  readonly onMaterialized: (profiles: readonly HarnessProfile[]) => Promise<void>
}) {
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [pending, setPending] = useState<ReadonlySet<HarnessProviderId>>(new Set())
  const [probes, setProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [selected, setSelected] = useState<ReadonlySet<HarnessProviderId>>(new Set())
  const [manualProviderId, setManualProviderId] = useState<HarnessProviderId | undefined>(
    () => defaultManualProvider(providers),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const policy = useRef(new HarnessProfileRequestPolicy())
  const templates = useMemo(
    () => providers.filter((provider) => provider.profileTemplate && !provider.default),
    [providers],
  )
  const configuredProviderIds = useMemo(
    () => new Set(profiles.map((profile) => profile.providerId)),
    [profiles],
  )

  useEffect(() => {
    const policyOwner = policy.current
    if (!open) {
      policyOwner.switchWorkspace()
      setBusy(false)
      setPending(new Set())
      return
    }
    policyOwner.switchWorkspace()
    setProbes([])
    setSelected(new Set())
    setBusy(false)
    setError(undefined)
    setManualProviderId(defaultManualProvider(providers))
    setPending(new Set(templates.map(({ id }) => id)))
    for (const provider of templates) {
      const token = policyOwner.start(`probe:${provider.id}`)
      void window.hvir
        .invoke('harness:probe-templates', {
          root,
          providerIds: [provider.id],
          force: refreshGeneration > 0,
        })
        .then(([probe]) => {
          if (probe && policyOwner.isCurrent(token)) {
            setProbes((current) => mergeProfileProbe(current, probe))
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!policyOwner.isCurrent(token)) return
          setPending((current) => {
            const next = new Set(current)
            next.delete(provider.id)
            return next
          })
        })
    }
    return () => {
      policyOwner.switchWorkspace()
    }
  }, [open, providers, refreshGeneration, root, templates])

  const detected = templates.filter((provider) => {
    const probe = probes.find((candidate) => candidate.providerId === provider.id)
    return pending.has(provider.id) || probe?.status === 'available'
  })

  const toggle = useCallback((providerId: HarnessProviderId, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(providerId)
      else next.delete(providerId)
      return next
    })
  }, [])

  const materialize = useCallback(async (): Promise<void> => {
    if (selected.size === 0) return
    const token = policy.current.start('mutation')
    setBusy(true)
    setError(undefined)
    try {
      const created = await window.hvir.invoke('harness:profile-materialize', {
        root,
        providerIds: [...selected],
      })
      if (policy.current.isCurrent(token)) await onMaterialized(created)
    } catch (reason) {
      if (policy.current.isCurrent(token)) setError(editorErrorMessage(reason))
    } finally {
      if (policy.current.isCurrent(token)) setBusy(false)
    }
  }, [onMaterialized, root, selected])

  return {
    pending,
    selected,
    manualProviderId,
    busy,
    error,
    detected,
    configuredProviderIds,
    refresh: () => setRefreshGeneration((value) => value + 1),
    toggle,
    setManualProviderId,
    materialize,
  }
}

function defaultManualProvider(
  providers: readonly HarnessProviderDescriptor[],
): HarnessProviderId | undefined {
  const provider =
    providers.find(({ profileTemplate }) => !profileTemplate) ??
    providers.find(({ default: isDefault }) => isDefault) ??
    providers[0]
  return provider?.id
}
