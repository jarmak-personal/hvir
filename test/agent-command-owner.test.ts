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
import { localPath } from '../src/shared/host-path'
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
