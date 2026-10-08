import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentWorkbenchCommandOwner,
  type AgentWorkbenchPorts,
} from '../src/main/agent/command-owner'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { ExtensionContextOwner } from '../src/main/extensions/context-owner'
import { ProjectRegistry } from '../src/main/project-registry'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { AGENT_CONTRACT, validateAgentRequest } from '../src/shared/agent/contract'
import { contextFixture } from './fixtures/extension-context'
function fixture() {
  const context = contextFixture(),
    reports = new AgentReportOwner(() => undefined)
  const access = new LocalAgentAccessOwner(
    () => undefined,
    () => Promise.resolve(),
  )
  const ports: AgentWorkbenchPorts = {
    contexts: () => context.contexts,
    activeInstallations: () => [],
    activeInstallation: () => undefined,
    openView: vi.fn(),
    invokeAction: vi.fn(),
    access,
    reports,
    presentationOwner: () => ({ id: 1, generation: 1 }),
    assertOwner: () => undefined,
    host: () => undefined,
    openDocument: vi.fn(),
  }
  const owner = new AgentWorkbenchCommandOwner(ports)
  const run = (argv: string[], stdin = '', defaults = {}) =>
    owner.run(
      { contract: AGENT_CONTRACT, argv, stdin, defaults },
      {
        id: 'connection',
        origin: 'application-local',
        signal: new AbortController().signal,
      },
    )
  return { ...context, reports, access, ports, run }
}
describe('agent commands through capability owners', () => {
  it('withdraws by handle outside a terminal without selection or extension authority, preserving another report', async () => {
    const f = fixture()
    await f.access.configure({ enabled: true, confirmDestructive: false })
    const report = f.reports.publish('workspace', f.root, 'First', 'text', 'old')
    const other = f.reports.publish('workspace', f.root, 'Other', 'text', 'kept')
    const state = f.sources.projectState()
    vi.spyOn(f.sources, 'projectState').mockReturnValue({
      ...state,
      activeWorkspaceId: 'other',
      projects: state.projects.map((project) => ({
        ...project,
        activeWorkspaceId: 'other',
        workspaces: [
          ...project.workspaces,
          { ...project.workspaces[0]!, id: 'other', root: localPath('/other') },
        ],
      })),
    })
    const response = await f.run(['report', '--handle', report.handle, '--close'])
    expect(response.exitStatus).toBe(0)
    expect(JSON.parse(response.stdout)).toMatchObject({
      report: { id: report.id, workspace: 'workspace', closed: true },
    })
    expect(f.reports.snapshot()).toEqual([
      expect.objectContaining({ id: other.id, unread: true }),
    ])
    expect(f.sources.projectState().activeWorkspaceId).toBe('other')
    expect(f.ports.openView).not.toHaveBeenCalled()
    expect(f.ports.invokeAction).not.toHaveBeenCalled()
    expect(
      (await f.run(['report', '--handle', report.handle, '--close'])).exitStatus,
    ).toBe(69)
    expect((await f.run(['report', '--handle', other.id, '--close'])).exitStatus).toBe(69)
  })

  it('refuses conflicting targets, stale defaults/root binding and content without withdrawing', async () => {
    const f = fixture()
    await f.access.configure({ enabled: true, confirmDestructive: false })
    const report = f.reports.publish('workspace', f.root, 'First', 'text', 'kept')
    const close = ['report', '--handle', report.handle, '--close']
    for (const [argv, defaults] of [
      [[...close, '--workspace', 'other'], {}],
      [[...close, '--session', 'stale'], {}],
      [close, { workspace: 'other' }],
      [close, { session: 'stale' }],
    ] as const)
      expect((await f.run([...argv], '', defaults)).exitStatus).toBe(69)
    expect((await f.run(close, 'ignored content')).exitStatus).toBe(64)
    const rootChanged = f.reports.publish(
      'workspace',
      localPath('/different'),
      'Moved',
      'text',
      'kept',
    )
    expect(
      (await f.run(['report', '--handle', rootChanged.handle, '--close'])).exitStatus,
    ).toBe(69)
    expect(f.reports.snapshot()).toHaveLength(2)
  })

  it('fences access Off before withdrawal but returns completed withdrawal truthfully after revocation', async () => {
    const f = fixture()
    const report = f.reports.publish('workspace', f.root, 'First', 'text', 'kept')
    const close = ['report', '--handle', report.handle, '--close']
    expect((await f.run(close)).exitStatus).toBe(69)
    await f.access.configure({ enabled: true, confirmDestructive: false })
    let revoked: Promise<void> | undefined
    vi.spyOn(f.ports, 'assertOwner').mockImplementationOnce(() => {
      revoked = f.access.configure({ enabled: false, confirmDestructive: false })
    })
    expect((await f.run(close)).exitStatus).toBe(69)
    await revoked
    expect(f.reports.read(report.id).content).toBe('kept')
    await f.access.configure({ enabled: true, confirmDestructive: false })
    const original = f.reports.withdraw.bind(f.reports)
    vi.spyOn(f.reports, 'withdraw').mockImplementation((...args) => {
      const completed = original(...args)
      revoked = f.access.configure({ enabled: false, confirmDestructive: false })
      return completed
    })
    expect((await f.run(close)).exitStatus).toBe(0)
    await revoked
    expect(() => f.reports.read(report.id)).toThrow('closed')
  })

  it('uses trusted SSH host/generation scope for handle withdrawal, never caller claims', async () => {
    const f = fixture(),
      scopes = new AgentForwardScopeOwner(() => undefined)
    scopes.register('ssh', 'current')
    const root = hostPath(asHostId('ssh'), '/remote')
    const state = f.sources.projectState()
    const contexts = new ExtensionContextOwner({
      ...f.sources,
      projectState: () => ({
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          workspaces: [
            ...project.workspaces,
            { ...project.workspaces[0]!, id: 'remote', root },
          ],
        })),
      }),
    })
    vi.spyOn(f.ports, 'contexts').mockReturnValue(contexts)
    const owner = new AgentWorkbenchCommandOwner({ ...f.ports, forwardScopes: scopes })
    await f.access.configure({ enabled: true, confirmDestructive: false })
    const local = f.reports.publish('workspace', f.root, 'Local', 'text', 'kept')
    const remote = f.reports.publish('remote', root, 'Remote', 'text', 'kept')
    const run = (handle: string, generation = 'current', extra: string[] = []) =>
      owner.run(
        {
          contract: AGENT_CONTRACT,
          argv: ['report', '--handle', handle, '--close', ...extra],
          stdin: '',
          defaults: {},
        },
        {
          id: 'forwarded',
          origin: 'ssh-forward',
          host: asHostId('ssh'),
          generation,
          signal: new AbortController().signal,
          current: () => undefined,
        },
      )
    expect((await run(local.handle)).exitStatus).toBe(69)
    expect((await run(remote.handle, 'stale')).exitStatus).toBe(69)
    expect(
      (await run(remote.handle, 'current', ['--workspace', 'workspace'])).exitStatus,
    ).toBe(69)
    expect(
      (await run(remote.handle, 'current', ['--origin', 'application-local'])).exitStatus,
    ).toBe(64)
    const forged = validateAgentRequest({
      contract: AGENT_CONTRACT,
      argv: ['report', '--handle', local.handle, '--close'],
      stdin: '',
      defaults: {},
      origin: 'application-local',
      host: 'local',
      authorization: 'human',
    })
    expect(
      (
        await owner.run(forged, {
          id: 'forwarded',
          origin: 'ssh-forward',
          host: asHostId('ssh'),
          generation: 'current',
          signal: new AbortController().signal,
          current: () => undefined,
        })
      ).exitStatus,
    ).toBe(69)
    expect((await run(remote.handle)).exitStatus).toBe(0)
    expect(f.reports.snapshot()).toEqual([
      expect.objectContaining({ id: local.id, unread: true }),
    ])
    scopes.revoke('ssh')
    expect((await run(local.handle)).exitStatus).toBe(69)
  })
  it('uses a real registered nested workspace identity through explicit CLI targets and protected defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-agent-workspace-')),
      nested = join(
        directory,
        ...Array.from({ length: 5 }, () => 'nested-project-directory'),
      ),
      host = new LocalHost(),
      f = fixture()
    await mkdir(nested, { recursive: true })
    const registry = await ProjectRegistry.create(
      localPath(nested),
      {
        local: host,
        hostById: () => host,
        materializeHost: () => Promise.resolve(host),
        onHostStateChange: () => () => undefined,
      },
      join(directory, 'projects.json'),
      () => undefined,
    )
    try {
      const state = registry.state(),
        workspace = state.activeWorkspaceId
      expect(workspace.length).toBeGreaterThan(128)
      expect(workspace).toBe(`workspace:local:${state.root.path}`)
      const contexts = new ExtensionContextOwner({
        ...f.sources,
        projectState: () => registry.state(),
        ptys: {
          ...f.sources.ptys,
          observationSnapshot: () =>
            f.sources.ptys.observationSnapshot().map((entry) => ({
              ...entry,
              info: { ...entry.info, workspaceRoot: state.root },
            })),
        },
      })
      vi.spyOn(f.ports, 'contexts').mockReturnValue(contexts)
      await f.access.configure({ enabled: true, confirmDestructive: false })
      for (const request of [
        validateAgentRequest({
          contract: AGENT_CONTRACT,
          argv: ['report', '--workspace', workspace, '--stdin'],
          stdin: 'explicit',
          defaults: {},
        }),
        validateAgentRequest({
          contract: AGENT_CONTRACT,
          argv: ['report', '--stdin'],
          stdin: 'protected',
          defaults: { workspace },
        }),
        validateAgentRequest({
          contract: AGENT_CONTRACT,
          argv: ['workspaces'],
          stdin: '',
          defaults: { workspace },
        }),
      ]) {
        expect(
          (await f.run([...request.argv], request.stdin, request.defaults)).exitStatus,
        ).toBe(0)
      }
      expect(f.reports.snapshot().every((report) => report.workspace === workspace)).toBe(
        true,
      )
    } finally {
      await registry.dispose()
      await host.dispose()
      await rm(directory, { recursive: true })
    }
  })
  it('explicit workspace and session selections replace inherited target defaults without changing desktop selection', async () => {
    const f = fixture(),
      other = localPath('/other'),
      state = f.sources.projectState()
    const contexts = new ExtensionContextOwner({
      ...f.sources,
      projectState: () => ({
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          workspaces: [
            ...project.workspaces,
            { ...project.workspaces[0]!, id: 'other', root: other },
          ],
        })),
      }),
      ptys: {
        ...f.sources.ptys,
        observationSnapshot: () =>
          f.sources.ptys
            .observationSnapshot()
            .map((entry, index) =>
              index ? { ...entry, info: { ...entry.info, workspaceRoot: other } } : entry,
            ),
      },
    })
    vi.spyOn(f.ports, 'contexts').mockReturnValue(contexts)
    await f.access.configure({ enabled: true, confirmDestructive: false })
    const defaults = { workspace: 'workspace', session: f.id(1) }
    const selected = await f.run(
      ['report', '--workspace', 'other', '--stdin'],
      'explicit',
      defaults,
    )
    expect(selected.exitStatus).toBe(0)
    const session = contexts
      .sessionsForAgents()
      .find((entry) => entry.workspace.id === 'other')!.id
    expect(
      (await f.run(['report', '--session', session, '--stdin'], 'session', defaults))
        .exitStatus,
    ).toBe(0)
    expect(f.reports.snapshot().every((report) => report.root.path === other.path)).toBe(
      true,
    )
    expect(
      (
        await f.run(
          ['report', '--workspace', 'other', '--session', f.id(1), '--stdin'],
          'mismatch',
          defaults,
        )
      ).exitStatus,
    ).toBe(69)
    expect(f.sources.projectState().activeWorkspaceId).toBe('workspace')
  })
  it('rejects client-only reference commands without reading runtime assets', async () => {
    const f = fixture()
    for (const argv of [['help'], ['guide', 'access'], ['commands']])
      expect((await f.run(argv)).exitStatus).toBe(64)
  })
  it('requires standing access, validates stale environment, and leaves reporting usable without actions', async () => {
    const f = fixture()
    expect((await f.run(['workspaces'])).exitStatus).toBe(69)
    await f.access.configure({ enabled: true, confirmDestructive: false })
    expect(
      (
        JSON.parse(
          (await f.run(['workspaces', '--filter', 'Workspace', '--limit', '1'])).stdout,
        ) as { items: unknown[] }
      ).items,
    ).toHaveLength(1)
    expect((await f.run(['workspaces'], '', { session: 'stale' })).exitStatus).toBe(69)
    expect(
      (await f.run(['run', '--extension', 'unavailable', '--action', 'missing']))
        .exitStatus,
    ).toBe(69)
    const result = await f.run(
      ['report', '--workspace', 'workspace', '--stdin'],
      '# retained',
    )
    const { report } = JSON.parse(result.stdout) as { report: { id: string } }
    expect(result.exitStatus).toBe(0)
    await f.access.configure({
      enabled: false,
      confirmDestructive: false,
    })
    expect(f.reports.read(report.id).content).toBe('# retained')
    expect(
      (await f.run(['report', '--workspace', 'workspace'], 'later')).exitStatus,
    ).toBe(69)
    expect(f.ports.invokeAction).not.toHaveBeenCalled()
  })
  it.each(['close', 'disconnect', 'exit', 'move'] as const)(
    'does not recover a stale exact session after %s',
    async (change) => {
      const f = fixture(),
        session = f.id(1)
      await f.access.configure({
        enabled: true,
        confirmDestructive: false,
      })
      f.change(change)
      expect(
        (await f.run(['report', '--workspace', 'workspace', '--session', session], 'bad'))
          .exitStatus,
      ).toBe(69)
      expect(f.reports.snapshot()).toEqual([])
    },
  )
})
