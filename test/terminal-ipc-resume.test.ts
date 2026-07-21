import { describe, expect, it, vi } from 'vitest'

import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import {
  LOCAL_HOST_ID,
  asHostId,
  hostPath,
  type HostPath,
  type StartPtyRequest,
  type StartPtyResponse,
} from '../src/shared'

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('terminal exact-resume IPC', () => {
  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-resume-test')],
  ])(
    'returns typed unavailability without allocating resources on a %s ProjectHost',
    async (_kind, hostId) => {
      const root = hostPath(hostId, '/repo')
      const profile = {
        ...providerTemplateProfiles().find(
          (candidate) => candidate.providerId === 'claude-code',
        )!,
        environment: [
          {
            kind: 'literal' as const,
            name: 'CLAUDE_CONFIG_DIR',
            value: '/config/claude',
          },
        ],
        risk: 'unclassified' as const,
      }
      const exec = vi.fn<ProjectHost['exec']>().mockResolvedValue({
        code: 0,
        signal: null,
        stdout: 'missing',
        stderr: '',
      })
      const host = {
        hostId,
        connectionState: 'connected',
        watchTier: hostId === LOCAL_HOST_ID ? 'native' : 'polling',
        defaultShell: vi.fn(() => Promise.resolve('/bin/sh')),
        realpath: vi.fn((path) => Promise.resolve(path)),
        exec,
      } as unknown as ProjectHost
      const authorizeResume = vi.fn(() => true)
      const recordSpawn = vi.fn(() => Promise.resolve())
      const register = vi.fn()
      const spawn = vi.fn()
      const handlers = new Map<
        string,
        (request: unknown, context: IpcInvokeContext) => unknown
      >()
      const ipc = {
        authority: {
          workspaceRoot: vi.fn((path: HostPath): HostPath => path),
          projectRoot: vi.fn(() => root),
        },
        handle: (
          channel: string,
          handler: (request: unknown, context: IpcInvokeContext) => unknown,
        ) => handlers.set(channel, handler),
        handleSend: vi.fn(),
      } as unknown as IpcRegistrar
      const deps = {
        getProject: () => ({ root, host }),
        terminalSessions: {
          authorizeResume,
          recordSpawn,
        },
        harnessProfiles: {
          get: () => profile,
          hasPathGrant: () => false,
        },
        harnessProbes: {
          invalidate: vi.fn(),
          probeProfiles: vi.fn(),
        },
        rendererResources: {
          register,
        },
        ptySupervisor: {
          spawn,
          disposeSession: vi.fn(),
        },
        terminalMoves: {
          plan: vi.fn(),
          move: vi.fn(),
        },
      } as unknown as Parameters<typeof registerTerminalIpc>[1]
      registerTerminalIpc(ipc, deps)
      const start = handlers.get('pty:start') as (
        request: StartPtyRequest,
        context: IpcInvokeContext,
      ) => Promise<StartPtyResponse>

      const result = await start(
        {
          sessionId: 'terminal-1',
          profileId: profile.id,
          launchRevision: profile.launchRevision,
          cwd: root,
          cols: 80,
          rows: 24,
          title: 'Retained conversation',
          position: 0,
          active: true,
          composerSubmitMode: 'enter',
          resume: true,
          harnessSessionId: HARNESS_SESSION_ID,
          acknowledgeRisk: true,
        },
        {
          owner: () => ({ id: 7, generation: 1 }),
          authority: ipc.authority,
          sender: { isDestroyed: () => false, send: vi.fn() },
        } as unknown as IpcInvokeContext,
      )

      expect(result).toEqual({
        outcome: 'resume-unavailable',
        reason: 'artifact-missing',
      })
      expect(authorizeResume).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'terminal-1',
          harnessSessionId: HARNESS_SESSION_ID,
          workspaceRoot: root,
          cwd: root,
        }),
      )
      expect(exec).toHaveBeenCalledWith(
        'sh',
        expect.any(Array),
        expect.objectContaining({
          env: { CLAUDE_CONFIG_DIR: '/config/claude' },
        }),
      )
      expect(register).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(recordSpawn).not.toHaveBeenCalled()
    },
  )
})
