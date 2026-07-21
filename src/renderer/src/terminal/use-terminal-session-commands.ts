import { useState, type RefObject } from 'react'

import type {
  HarnessProfile,
  HarnessProfileId,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HostPath,
} from '../../../shared'
import { profileRiskAcknowledged } from './terminal-profile-recovery'
import { profileProbe } from './terminal-probe-policy'
import type { TerminalRuntimeRegistry } from './terminal-runtime'
import {
  createTerminalSession,
  nextTerminalSplitPane,
  terminalWorkspaceSplit,
  type TerminalWorkspaceAction,
  type TerminalWorkspaceModel,
} from './terminal-workspace-model'

export function useTerminalSessionCommands({
  available,
  workspaceRoot,
  profiles,
  providers,
  probes,
  defaultProfile,
  defaultProvider,
  modelRef,
  send,
  closeLaunchMenu,
  focusAttention,
  forgetAttention,
  runtimes,
}: {
  readonly available: boolean
  readonly workspaceRoot: HostPath
  readonly profiles: readonly HarnessProfile[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly defaultProfile?: HarnessProfile
  readonly defaultProvider?: HarnessProviderDescriptor
  readonly modelRef: RefObject<TerminalWorkspaceModel>
  readonly send: (action: TerminalWorkspaceAction) => void
  readonly closeLaunchMenu: () => void
  readonly focusAttention: (id: string) => void
  readonly forgetAttention: (id: string) => void
  readonly runtimes: TerminalRuntimeRegistry
}) {
  const [pendingRiskProfile, setPendingRiskProfile] = useState<HarnessProfile>()

  const launch = (
    profile: HarnessProfile,
    provider: HarnessProviderDescriptor,
    riskAcknowledged: boolean,
  ): void => {
    const current = modelRef.current
    const pane = terminalWorkspaceSplit(current) ? current.activePane : 'primary'
    send({
      type: 'session-added',
      session: createTerminalSession(
        crypto.randomUUID(),
        profile,
        provider,
        workspaceRoot,
        pane,
        riskAcknowledged,
        profileProbe(probes, profile)?.capabilities,
      ),
    })
    closeLaunchMenu()
  }

  const add = (profileId: HarnessProfileId): void => {
    if (!available) return
    const profile = profiles.find((candidate) => candidate.id === profileId)
    const provider = profile
      ? providers.find((candidate) => candidate.id === profile.providerId)
      : undefined
    if (!provider || !profile) return
    const acknowledged = profileRiskAcknowledged(profile)
    if (acknowledged) launch(profile, provider, acknowledged)
    else {
      setPendingRiskProfile(profile)
      closeLaunchMenu()
    }
  }

  return {
    pendingRiskProfile,
    cancelRisk: () => setPendingRiskProfile(undefined),
    launchAcknowledged: (profile: HarnessProfile, provider: HarnessProviderDescriptor) =>
      launch(profile, provider, true),
    add,
    focus: (id: string) => {
      focusAttention(id)
      send({ type: 'session-focused', id })
    },
    split: () => {
      if (!available || !defaultProvider || !defaultProfile) return
      send({
        type: 'session-added',
        session: createTerminalSession(
          crypto.randomUUID(),
          defaultProfile,
          defaultProvider,
          workspaceRoot,
          nextTerminalSplitPane(modelRef.current),
        ),
      })
    },
    moveToOtherPane: (id: string) => send({ type: 'session-moved', id }),
    close: (id: string) => {
      forgetAttention(id)
      runtimes.disposeSession(id)
      void window.hvir
        .invoke('terminal:forget', { root: workspaceRoot, id })
        .catch(() => undefined)
      send({ type: 'session-closed', id })
    },
  }
}
