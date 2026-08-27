import { describe, expect, it, vi } from 'vitest'

import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerSessionsIpc } from '../src/main/ipc/features/sessions'
import type { SessionsResolvedOpen } from '../src/main/sessions/sessions-observation-port'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  SESSIONS_PROJECTION_VERSION,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
} from '../src/shared'

describe('Sessions IPC', () => {
  it('registers one renderer-qualified demand and releases it on rollover', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(17)
    let activeDemand: number | undefined
    const observation = {
      acquire: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== undefined && activeDemand !== demandGeneration) {
          throw new Error('Sessions observation demand is already active')
        }
        activeDemand = demandGeneration
        return snapshot(demandGeneration, 1)
      }),
      snapshot: vi.fn((_owner, demandGeneration: number) =>
        snapshot(demandGeneration, 2),
      ),
      release: vi.fn(() => true),
    }
    const { invoke } = fixture(scopes, observation)
    const context = { owner: () => owner }

    await expect(
      invoke('sessions:observe', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ demandGeneration: 4, revision: 1 })
    await expect(
      invoke('sessions:observe', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ demandGeneration: 4, revision: 1 })
    expect(observation.acquire).toHaveBeenNthCalledWith(1, owner, 4)
    expect(observation.acquire).toHaveBeenNthCalledWith(2, owner, 4)
    await expect(
      invoke('sessions:observe', { demandGeneration: 5 }, context),
    ).rejects.toThrow('already active')
    expect(observation.release).not.toHaveBeenCalledWith(owner, 5)

    await expect(
      invoke('sessions:snapshot', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ revision: 2 })

    const rollover = scopes.rolloverOwner(owner.id)
    await rollover.cleanup
    expect(observation.release).toHaveBeenCalledWith(owner, 4)
    await scopes.dispose()
  })

  it('makes explicit release idempotent through the renderer resource owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(3)
    let activeDemand: number | undefined
    const observation = {
      acquire: vi.fn((_owner, demandGeneration: number) => {
        activeDemand = demandGeneration
        return snapshot(demandGeneration, 1)
      }),
      snapshot: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== demandGeneration) throw new Error('stale demand')
        return snapshot(demandGeneration, 1)
      }),
      release: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== demandGeneration) return false
        activeDemand = undefined
        return true
      }),
    }
    const { invoke } = fixture(scopes, observation)
    const context = { owner: () => owner }

    await invoke('sessions:observe', { demandGeneration: 8 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await invoke('sessions:observe', { demandGeneration: 9 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await expect(
      invoke('sessions:snapshot', { demandGeneration: 9 }, context),
    ).resolves.toMatchObject({ demandGeneration: 9 })

    expect(observation.release).toHaveBeenCalledTimes(4)
    expect(observation.release).toHaveBeenNthCalledWith(1, owner, 8)
    expect(observation.release).toHaveBeenNthCalledWith(2, owner, 8)
    expect(observation.release).toHaveBeenNthCalledWith(4, owner, 8)
    await scopes.dispose()
    expect(observation.release).toHaveBeenLastCalledWith(owner, 9)
  })

  it('routes only an exactly resolved Open through the existing workspace owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(11)
    const qualifier = sessionsWorkspaceQualifier(3, 0, 0)
    const livePty = {
      handle: asSessionsPtyHandle('instance-1'),
      rendererOwnerId: owner.id,
      rendererGeneration: owner.generation,
    }
    const resolveOpen = vi.fn((): SessionsResolvedOpen => ({
      outcome: 'resolved',
      projectId: 'project-real',
      workspaceId: 'workspace-real',
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceQualifier: qualifier,
      livePty,
    }))
    const observation = {
      acquire: vi.fn(),
      snapshot: vi.fn(),
      release: vi.fn(),
      resolveOpen,
    }
    const switchWorkspace = vi.fn(() =>
      Promise.resolve({ marker: 'production-project-state' }),
    )
    const { invoke } = fixture(scopes, observation, switchWorkspace)
    const request = {
      demandGeneration: 4,
      sourceRevision: 7,
      handle: asSessionsTerminalHandle('terminal-1'),
      projectId: asSessionsProjectHandle('project-opaque'),
      workspaceId: asSessionsWorkspaceHandle('workspace-opaque'),
      workspaceQualifier: qualifier,
      livePty,
    }

    await expect(
      invoke('sessions:open', request, { owner: () => owner }),
    ).resolves.toEqual({
      outcome: 'opened',
      state: { marker: 'production-project-state' },
      handle: 'terminal-1',
      workspaceQualifier: qualifier,
      livePty,
    })
    expect(observation.resolveOpen).toHaveBeenCalledWith(owner, request)
    expect(switchWorkspace).toHaveBeenCalledExactlyOnceWith(
      'project-real',
      'workspace-real',
    )

    resolveOpen.mockReturnValueOnce({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    await expect(
      invoke('sessions:open', request, { owner: () => owner }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    expect(switchWorkspace).toHaveBeenCalledOnce()
    await scopes.dispose()
  })
})

function fixture(
  rendererResources: RendererResourceScopes,
  sessionsObservation: {
    acquire: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    resolveOpen?: ReturnType<typeof vi.fn>
  },
  switchWorkspace = vi.fn(),
) {
  const handlers = new Map<string, (request: never, context: never) => unknown>()
  const ipc = {
    handle: (channel: string, handler: (request: never, context: never) => unknown) => {
      handlers.set(channel, handler)
    },
  } as unknown as IpcRegistrar
  registerSessionsIpc(ipc, {
    rendererResources,
    sessionsObservation: {
      ...sessionsObservation,
      resolveOpen:
        sessionsObservation.resolveOpen ??
        vi.fn(() => ({ outcome: 'unavailable', reason: 'stale-projection' })),
    },
    switchWorkspace,
  } as never)
  return {
    invoke: (channel: string, request: unknown, context: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing handler ${channel}`)
      return Promise.resolve().then(() => handler(request as never, context as never))
    },
  }
}

function snapshot(
  demandGeneration: number,
  revision: number,
): SessionsObservationSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision,
    workspaces: [],
    providers: [],
    sessions: [],
  }
}
