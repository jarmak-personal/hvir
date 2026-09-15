import { expect, it, vi, onTestFinished } from 'vitest'
import { installSkillager } from '../src/main/skillager/skillager-application'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { LocalHost } from '../src/main/project-host/local-host'
import { asHostId, hostPath, hostPathEquals, localPath } from '../src/shared/host-path'
import { projectState, selection } from './fixtures/skillager-exposure-fixture'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

vi.mock('../src/main/application-runtime', () => ({
  applicationUserDataPath: (name: string) => '/unread-skillager-state/' + name,
}))

it('production wiring keeps Personal metadata/review independent of disconnected destination admission', async () => {
  const root = hostPath(asHostId('ssh:fixture'), '/workspace')
  const state = projectState(root)
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const host = new LocalHost()
  const dispose: (() => unknown)[] = []
  const authority = vi.fn(() => undefined)
  const preview = vi.spyOn(SkillagerCli.prototype, 'nativeSnapshot')
  vi.spyOn(SkillagerCli.prototype, 'probe').mockResolvedValue(selection)
  vi.spyOn(SkillagerCli.prototype, 'validate').mockResolvedValue(undefined)
  vi.spyOn(SkillagerCli.prototype, 'inventory').mockResolvedValue([])
  const review = vi.spyOn(SkillagerCli.prototype, 'review').mockResolvedValue({
    detail: {
      skillId: 'lib/demo',
      root: localPath('/library/skills/demo'),
      hash: 'a'.repeat(64),
      canAccept: true,
      files: [],
      findings: [],
      lintStatus: 'ok',
      scanRisk: 'low',
      history: { available: false, reason: 'no-git', versions: [] },
    },
    bytes: new Map(),
    dispose: () => Promise.resolve(),
  })
  const capability = installSkillager(
    {
      own: (_name, value, release) => {
        dispose.push(() => release(value))
        return value
      },
    },
    host,
    resources.scopes,
    {
      active: { root, host, projectId: 'project', workspaceId: 'origin' },
      registeredWorkspaceRoot: (at) => (hostPathEquals(at, root) ? root : undefined),
      authorityForPath: authority,
      state: () => ({
        ...state,
        connectionState: 'disconnected',
        projects: state.projects.map((project) => ({
          ...project,
          connectionState: 'disconnected',
        })),
      }),
    },
    {
      create: () => {
        throw Error('Unexpected HTML content')
      },
      release: () => {},
    },
  )
  onTestFinished(async () => {
    for (const release of dispose.reverse()) await release()
    await host.dispose()
    vi.restoreAllMocks()
  })
  capability.configure(owner, true)
  const probe = await capability.probe(owner)
  if (!probe.ok) throw Error(probe.message)
  const connected = await capability.connect(owner, probe.value.probeId)
  if (!connected.ok) throw Error(connected.message)
  const request = {
    connectionId: connected.value.connectionId,
    workspaceRoot: root,
    agent: 'codex' as const,
    requestId: 1,
  }
  expect(await capability.inventory(owner, request)).toMatchObject({
    ok: true,
    value: { rows: [] },
  })
  expect(
    await capability.review(owner, { ...request, skillId: 'lib/demo' }),
  ).toMatchObject({ ok: true })
  expect(review).toHaveBeenCalledOnce()
  expect(
    await capability.previewExposure(owner, {
      ...request,
      action: 'add',
      mode: 'native',
      skillId: 'lib/demo',
      destination: { projectId: 'project', workspaceId: 'origin', root },
    }),
  ).toMatchObject({ ok: false })
  expect(authority).not.toHaveBeenCalled()
  expect(preview).not.toHaveBeenCalled()
})
