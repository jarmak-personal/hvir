import { expect, it, vi } from 'vitest'
import { registerHarnessIpc } from '../src/main/ipc/features/harness'
import { IpcAuthority, type IpcRegistrar } from '../src/main/ipc/authority-router'
import type { IpcDeps } from '../src/main/ipc/deps'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, localPath, type ProjectState } from '../src/shared'

it.each([
  'harness:probe-snapshot',
  'harness:probe-profiles',
  'harness:probe-templates',
] as const)(
  'probes the requested registered workspace host through %s without selecting it',
  async (channel) => {
    const root = hostPath(asHostId('ssh-fixture'), '/repo')
    const remote = { hostId: root.hostId } as ProjectHost
    const state = {
      projects: [{ registeredRoot: root, workspaces: [{ root }] }],
    } as unknown as ProjectState
    const selected = vi.fn(() => ({ root: localPath('/other'), host: {} as ProjectHost }))
    const authority = new IpcAuthority({
      getProject: selected,
      getProjectState: () => state,
      getRegisteredWorkspaceRoot: (candidate) =>
        candidate.hostId === root.hostId && candidate.path === root.path
          ? root
          : undefined,
    })
    const handlers = new Map<string, (request: { root: typeof root }) => unknown>()
    const probes = {
      snapshotProfiles: vi.fn(() => []),
      probeProfiles: vi.fn(() => Promise.resolve([])),
    }
    const registrar = {
      authority,
      handle: (name: string, handler: (request: { root: typeof root }) => unknown) =>
        handlers.set(name, handler),
    } as unknown as IpcRegistrar
    registerHarnessIpc(registrar, {
      getHost: () => remote,
      getProject: selected,
      harnessProfiles: { list: () => [] },
      harnessProbes: probes,
    } as unknown as IpcDeps)
    await handlers.get(channel)!({ root })
    expect(selected).not.toHaveBeenCalled()
    expect(
      channel === 'harness:probe-snapshot'
        ? probes.snapshotProfiles
        : probes.probeProfiles,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ host: remote, workspaceRoot: root, projectRoot: root }),
    )
    await expect(
      Promise.resolve().then(() =>
        handlers.get(channel)!({ root: hostPath(asHostId('unregistered'), '/repo') }),
      ),
    ).rejects.toThrow('no longer registered')
  },
)
