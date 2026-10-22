import { describe, expect, it, vi } from 'vitest'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { TerminalCommandCoordinator } from '../src/renderer/src/terminal/terminal-command-coordinator'
import { localPath, type HvirApi, type ProjectState } from '../src/shared'
import type { TerminalCommandRequest } from '../src/shared/ipc/terminal'
import type { TerminalWorkspaceController } from '../src/renderer/src/terminal/terminal-workspace-command-port'

function fixture() {
  const root = localPath('/project')
  const state: ProjectState = {
    revision: 1,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project',
    activeWorkspaceId: 'workspace',
    projects: [
      {
        id: 'project',
        registeredRoot: root,
        displayName: 'Project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace',
        workspaces: [
          {
            id: 'workspace',
            root,
            name: 'Project',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
  const request: TerminalCommandRequest = {
    ticket: 'opaque-main-ticket',
    terminalId: 'new-main-terminal',
    workspaceId: 'workspace',
    root,
  }
  const launch = vi.fn(() => request.terminalId),
    accept = vi.fn(),
    release = vi.fn()
  const prepare = vi.fn((_workspace: string, _forLaunch: boolean, _signal: AbortSignal) =>
    Promise.resolve(),
  )
  const api = {
    invoke: vi.fn((channel: string) => {
      if (channel === 'harness:profiles') return Promise.resolve(builtInProfiles())
      if (channel === 'project:switch') return Promise.resolve({ ok: true, value: state })
      throw new Error('Unexpected channel')
    }),
  } as unknown as Pick<HvirApi, 'invoke'>
  const coordinator = new TerminalCommandCoordinator({
    api,
    state: () => state,
    accept,
    prepare,
    release,
    controller: () =>
      ({ launchSession: launch }) as unknown as TerminalWorkspaceController,
  })
  return { coordinator, request, state, launch, accept, release, prepare }
}

describe('renderer opaque command admission', () => {
  it('opens only the exact new default-shell terminal without receiving command bytes', async () => {
    const f = fixture()
    await f.coordinator.open(f.request)
    expect(f.launch).toHaveBeenCalledExactlyOnceWith('plain-shell-default', 1, f.request)
    expect(f.prepare).toHaveBeenCalledWith('workspace', true, expect.any(AbortSignal))
    expect(f.release).toHaveBeenCalledExactlyOnceWith('workspace')
    f.coordinator.dispose()
  })
  it.each(['revoked', 'disposed', 'workspace-closed'] as const)(
    'does not finish a late materialization after %s',
    async (boundary) => {
      const f = fixture()
      let release!: () => void
      f.prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const opening = f.coordinator.open(f.request)
      const rejected = expect(opening).rejects.toThrow()
      await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce())
      if (boundary === 'revoked') f.coordinator.revoke(f.request.ticket)
      else if (boundary === 'disposed') f.coordinator.dispose()
      else Object.assign(f.state.projects[0]!.workspaces[0]!, { closed: true })
      release()
      await rejected
      expect(f.launch).not.toHaveBeenCalled()
      expect(f.release).toHaveBeenCalledOnce()
      f.coordinator.dispose()
    },
  )
})
