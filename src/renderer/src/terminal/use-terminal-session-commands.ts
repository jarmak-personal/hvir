import type { RefObject } from 'react'

import { hostPathEquals } from '../../../shared'
import type {
  HarnessProfile,
  HarnessProfileId,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HostPath,
  TerminalIdentityStatus,
} from '../../../shared'
import { profileProbe } from './terminal-probe-policy'
import { terminalForkAvailability } from './terminal-fork-policy'
import type { FreshTerminalStart } from './terminal-runtime-options'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import {
  createTerminalSession,
  createTerminalForkSession,
  nextTerminalSplitPane,
  terminalWorkspaceSplit,
  type TerminalWorkspaceAction,
  type TerminalWorkspaceModel,
  type PreparedTerminalSession,
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
  onError,
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
  readonly onError: (message: string) => void
}) {
  const launch = (profile: HarnessProfile, provider: HarnessProviderDescriptor): void => {
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
    launch(profile, provider)
  }

  const failStart = (id: string, reason: string): void => {
    const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
    if (!session?.forkRequest && !session?.initialStart) return
    runtimes.disposeSession(id)
    void window.hvir
      .invoke('terminal:forget', { root: workspaceRoot, id })
      .catch(() => undefined)
    if (session.forkRequest) {
      send({
        type: 'session-fork-failed',
        sourceId: session.forkRequest.sourceSessionId,
        id,
      })
      onError(`Conversation fork failed: ${reason}`)
    } else {
      forgetAttention(id)
      send({ type: 'session-closed', id })
      onError(`Terminal launch failed: ${reason}`)
    }
  }

  const acceptForkIdentity = (
    id: string,
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus,
    identityDiverged?: true,
  ): void => {
    const fork = modelRef.current.sessions.find(
      (session) => session.id === id && session.forkRequest,
    )
    if (!fork?.forkRequest) {
      const pendingChild = modelRef.current.sessions.find(
        (session) => session.forkRequest?.sourceSessionId === id,
      )
      if (
        pendingChild?.forkRequest &&
        (identityDiverged ||
          identityStatus !== 'identified' ||
          harnessSessionId !== pendingChild.forkRequest.parentHarnessSessionId)
      ) {
        failStart(
          pendingChild.id,
          'The source conversation identity changed while its sibling was starting.',
        )
      }
      return
    }
    const source = modelRef.current.sessions.find(
      (session) => session.id === fork.forkRequest?.sourceSessionId,
    )
    const provider = source
      ? providers.find((candidate) => candidate.id === source.providerId)
      : undefined
    if (
      !source ||
      !provider ||
      !source.forkPending ||
      source.harnessSessionId !== fork.forkRequest.parentHarnessSessionId ||
      source.providerId !== fork.providerId ||
      source.profileId !== fork.profileId ||
      source.launchRevision !== fork.launchRevision ||
      !hostPathEquals(source.cwd, fork.cwd) ||
      !terminalForkAvailability(
        { ...source, forkPending: undefined },
        provider,
        runtimes.isSessionLive(source.id),
      ).available
    ) {
      failStart(id, 'The source terminal changed or exited before the fork completed.')
      return
    }
    if (identityDiverged) {
      failStart(id, 'The sibling conversation identity diverged during launch.')
      return
    }
    if (identityStatus === 'discovering') return
    if (
      identityStatus !== 'identified' ||
      !harnessSessionId ||
      harnessSessionId === fork.forkRequest.parentHarnessSessionId
    ) {
      failStart(id, 'The sibling conversation could not be identified exactly.')
      return
    }
    send({
      type: 'session-fork-succeeded',
      sourceId: fork.forkRequest.sourceSessionId,
      session: {
        ...fork,
        harnessSessionId,
        identityStatus,
        forkRequest: undefined,
      },
    })
  }

  return {
    add,
    addPrepared: (prepared: PreparedTerminalSession): boolean => {
      const profile = profiles.find((item) => item.id === prepared.profile.id)
      const provider = providers.find((item) => item.id === prepared.profile.providerId)
      if (
        !available ||
        !profile ||
        !provider ||
        profile.launchRevision !== prepared.profile.launchRevision ||
        modelRef.current.sessions.some((session) => session.id === prepared.id)
      )
        return false
      const session = createTerminalSession(
        prepared.id,
        profile,
        provider,
        workspaceRoot,
        modelRef.current.activePane,
      )
      send({
        type: 'session-added',
        session: {
          ...session,
          title: prepared.title,
          fallbackTitle: prepared.title,
          initialStart: prepared.initialStart,
        },
      })
      closeLaunchMenu()
      return true
    },
    fork: (sourceId: string) => {
      const source = modelRef.current.sessions.find((session) => session.id === sourceId)
      const provider = source
        ? providers.find((candidate) => candidate.id === source.providerId)
        : undefined
      if (!source || !provider) return
      const availability = terminalForkAvailability(
        source,
        provider,
        available && runtimes.isSessionLive(source.id),
      )
      if (!availability.available) return
      const fork = createTerminalForkSession(crypto.randomUUID(), source)
      if (!fork) return
      send({ type: 'session-fork-requested', sourceId, session: fork })
    },
    acceptForkIdentity,
    failStart,
    handleExit: (id: string, exitCode: number) => {
      const pendingChild = modelRef.current.sessions.find(
        (session) => session.forkRequest?.sourceSessionId === id,
      )
      if (pendingChild) {
        failStart(
          pendingChild.id,
          `The source terminal exited before the fork completed (${exitCode}).`,
        )
      }
    },
    startDefault: () => {
      if (
        !available ||
        modelRef.current.sessions.length > 0 ||
        !defaultProvider ||
        !defaultProfile
      ) {
        return
      }
      launch(defaultProfile, defaultProvider)
    },
    acceptFreshStart: (id: string, started: FreshTerminalStart) => {
      const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
      if (!session) return
      send({
        type: 'session-replaced',
        id,
        session: {
          ...session,
          id: started.sessionId,
          status: started.status,
          telemetry: undefined,
          attention: undefined,
          harnessSessionId: started.harnessSessionId,
          identityStatus: started.identityStatus,
          capabilities: started.capabilities,
          resumeOnStart: false,
        },
      })
    },
    focus: (id: string) => {
      focusAttention(id)
      send({ type: 'session-focused', id })
    },
    split: () => {
      if (!available || !defaultProvider || !defaultProfile) return
      const current = modelRef.current
      send({
        type: 'session-added',
        session: createTerminalSession(
          crypto.randomUUID(),
          defaultProfile,
          defaultProvider,
          workspaceRoot,
          current.sessions.length === 0 ? 'primary' : nextTerminalSplitPane(current),
        ),
      })
    },
    moveToOtherPane: (id: string) => send({ type: 'session-moved', id }),
    close: (id: string) => {
      forgetAttention(id)
      const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
      if (session?.forkRequest) {
        failStart(id, 'The pending sibling was closed before launch completed.')
        return
      }
      const pendingChild = modelRef.current.sessions.find(
        (candidate) => candidate.forkRequest?.sourceSessionId === id,
      )
      if (pendingChild) {
        failStart(
          pendingChild.id,
          'The source terminal was closed before the fork completed.',
        )
      }
      const pendingReplacementId = runtimes.disposeSession(id)
      if (pendingReplacementId) {
        void window.hvir
          .invoke('terminal:forget', { root: workspaceRoot, id: pendingReplacementId })
          .catch(() => undefined)
      }
      void window.hvir
        .invoke('terminal:forget', { root: workspaceRoot, id })
        .catch(() => undefined)
      send({ type: 'session-closed', id })
    },
  }
}
