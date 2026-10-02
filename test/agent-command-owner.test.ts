import { describe, expect, it, vi } from 'vitest'
import {
  AgentWorkbenchCommandOwner,
  type AgentWorkbenchPorts,
} from '../src/main/agent/command-owner'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { AGENT_CONTRACT } from '../src/shared/agent/contract'
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
    guide: () => [],
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
