import { webContents, type WebContents } from 'electron'
import type { HarnessProfile } from '../../shared'
import type {
  SkillagerProjectSetup,
  SkillagerProjectStart,
} from '../../shared/skillager-project'
import { harnessProvider } from '../harness/harness-provider'
import {
  builtInProfiles,
  type HarnessProfileStore,
} from '../harness/harness-profile-store'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { TerminalSessionStore } from '../terminal/session-registry'
import {
  startTerminalSession,
  type TerminalSessionStartDeps,
} from '../terminal/terminal-session-start'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'

export interface SkillagerProjectTerminalPort {
  profile(): HarnessProfile
  isRunning(sessionId: string, instanceId: string): boolean
  start(
    owner: RendererOwner,
    setup: SkillagerProjectSetup,
    selection: SkillagerCliSelection,
    request: SkillagerProjectStart,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): ReturnType<typeof startTerminalSession>
}

/** Adapts one explicit setup grant to the ordinary terminal session transaction. */
export function createSkillagerProjectTerminal(
  host: ProjectHost,
  deps: TerminalSessionStartDeps & {
    readonly profiles: Pick<HarnessProfileStore, 'get'>
    readonly sessions: Pick<TerminalSessionStore, 'recordSpawn' | 'forget'>
  },
  receiver: (owner: RendererOwner) => WebContents | undefined = (owner) =>
    webContents.fromId(owner.id),
): SkillagerProjectTerminalPort {
  return {
    isRunning: (id, instanceId) => deps.ptySupervisor.get(id)?.instanceId === instanceId,
    profile: () => {
      const defaultProfile = builtInProfiles()[0]
      const profile = defaultProfile ? deps.profiles.get(defaultProfile.id) : undefined
      if (!profile?.builtIn)
        throw new SkillagerError(
          'unavailable',
          'The ordinary Shell profile is unavailable.',
        )
      return profile
    },
    start: async (owner, setup, selection, request, signal, assertCurrent) => {
      const sender = receiver(owner)
      if (!sender || sender.isDestroyed())
        throw new SkillagerError('cancelled', 'The setup window is unavailable.')
      if (
        setup.projectRoot.hostId !== 'local' ||
        host.hostId !== 'local' ||
        !Number.isSafeInteger(request.position) ||
        request.position < 0 ||
        request.position >= 500 ||
        ![request.cols, request.rows].every(
          (n) => Number.isSafeInteger(n) && n >= 2 && n <= 1000,
        )
      )
        throw new SkillagerError('invalid-request', 'The setup terminal is unavailable.')
      const profile = deps.profiles.get(setup.profile.id)
      if (!profile || profile.launchRevision !== setup.profile.launchRevision)
        throw new SkillagerError(
          'cancelled',
          'The terminal profile changed. Select setup again.',
        )
      try {
        return await startTerminalSession(deps, {
          owner,
          sender,
          signal,
          assertCurrent,
          spawn: {
            host,
            provider: harnessProvider(profile.providerId),
            launchSpec: {
              file: selection.executable.path,
              args: [
                '--catalog-state-dir',
                selection.catalog.path,
                'setup',
                '--agent',
                setup.agent,
              ],
              env: { ...selection.environment },
            },
            profileId: profile.id,
            launchRevision: profile.launchRevision,
            providerContractVersion: profile.providerContractVersion,
            composerSubmitMode: 'enter',
            cwd: setup.projectRoot,
            workspaceRoot: setup.projectRoot,
            ownerId: owner.id,
            ownerGeneration: owner.generation,
            sessionId: setup.sessionId,
            launchMode: 'fresh',
            cols: request.cols,
            rows: request.rows,
          },
          record: (managed) =>
            deps.sessions.recordSpawn({
              id: managed.id,
              providerId: profile.providerId,
              profileId: profile.id,
              launchRevision: profile.launchRevision,
              workspaceRoot: setup.projectRoot,
              cwd: setup.projectRoot,
              title: 'Skillager setup',
              position: request.position,
              active: true,
            }),
        })
      } catch (error) {
        // A failed attachment never leaves a recoverable setup command or a shell fallback.
        await deps.sessions.forget(setup.projectRoot, setup.sessionId)
        throw error
      }
    },
  }
}
