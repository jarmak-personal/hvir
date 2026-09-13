import { expect, it, vi, onTestFinished } from 'vitest'
import { SkillagerCapability } from '../src/main/skillager/skillager-capability'
import {
  SkillagerError,
  type SkillagerCliPort,
} from '../src/main/skillager/skillager-port'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { localPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import type { SkillagerProjectCliPort } from '../src/main/skillager/skillager-project-commands'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import { selection } from './fixtures/skillager-exposure-fixture'

const root = localPath('/workspace')
const native: SkillagerMetadata = {
  id: 'project/guide',
  name: 'Project guide',
  description: 'Pending project skill',
  trust: 'discovered',
  source: { type: 'project', ownership: 'external' },
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
  projectSkill: {
    path: localPath('/workspace/.agents/skills/guide'),
    agent: 'codex',
    managed: false,
  },
}
const canonical: SkillagerMetadata = {
  ...native,
  id: 'lib/guide',
  name: 'Library guide',
  trust: 'discovered',
  projectSkill: undefined,
  source: { type: 'collection', ownership: 'library', libraryId: selection.library.id },
  contentHash: 'a'.repeat(64),
}
const status = {
  projectRoot: root,
  agent: 'codex' as const,
  status: 'review-needed',
  canProceed: false,
  reviewNeeded: 1,
  lintBlocked: 0,
  working: 'missing' as const,
}
function fixture(exposures: readonly SkillagerWorkspaceExposure[] = []) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const cli = {
    probe: vi.fn<SkillagerCliPort['probe']>(() => Promise.resolve(selection)),
    validate: vi.fn<SkillagerCliPort['validate']>(() => Promise.resolve()),
    search: vi.fn<SkillagerCliPort['search']>(() => Promise.resolve([])),
    exposures: vi.fn<SkillagerCliPort['exposures']>(() => Promise.resolve(exposures)),
    inventory: vi.fn<SkillagerCliPort['inventory']>(() =>
      Promise.resolve([canonical, { ...canonical, id: 'lib/unrelated' }]),
    ),
  } satisfies SkillagerCliPort
  const project = {
    projectMetadata: vi.fn<SkillagerProjectCliPort['projectMetadata']>(() =>
      Promise.resolve({ rows: [native], status }),
    ),
    projectStatus: vi.fn<SkillagerProjectCliPort['projectStatus']>(() =>
      Promise.resolve(status),
    ),
  } satisfies SkillagerProjectCliPort
  const unsupported = () => Promise.reject(Error('Unexpected mutation/content operation'))
  const capability = new SkillagerCapability(
    cli,
    resources.scopes,
    () => true,
    {
      cli: {
        review: unsupported,
        history: unsupported,
        diff: unsupported,
        accept: unsupported,
      },
      previews: {
        create: () => {
          throw Error('Unexpected preview')
        },
        release: () => {},
      },
    },
    {
      cli: {
        previewExposure: unsupported,
        applyExposure: unsupported,
        updateSourceHash: unsupported,
      },
      observe: (selected, request, _rows, signal) =>
        cli.exposures(selected, request, signal),
      destinationAvailable: () => true,
    },
    {
      cli: {
        defaultLibraryRoot: unsupported,
        initializeLibrary: unsupported,
        libraryStatus: unsupported,
      },
      picker: { choose: unsupported },
    },
    {
      cli: project,
      terminal: {
        profile: () => builtInProfiles()[0]!,
        isRunning: () => false,
        start: unsupported,
      },
    },
  )
  onTestFinished(() => capability.dispose())
  const connect = async () => {
    capability.configure(owner, true)
    const probe = await capability.probe(owner)
    if (!probe.ok) throw Error(probe.message)
    const connected = await capability.connect(owner, probe.value.probeId)
    if (!connected.ok) throw Error(connected.message)
    return {
      connectionId: connected.value.connectionId,
      requestId: 1,
      workspaceRoot: root,
      agent: 'codex' as const,
    }
  }
  return { capability, cli, project, owner, connect }
}

it('leaves Personal library inventory/search unchanged and adds no project discovery before project demand', async () => {
  const f = fixture(),
    request = await f.connect()
  expect(f.project.projectMetadata).not.toHaveBeenCalled()
  await f.capability.inventory(f.owner, request)
  await f.capability.search(f.owner, { ...request, query: 'guide', scope: 'library' })
  expect(f.project.projectMetadata).not.toHaveBeenCalled()
  expect(f.project.projectStatus).not.toHaveBeenCalled()
  expect(f.cli.inventory).toHaveBeenCalledOnce()
})

it('observes native project metadata independently of an empty personal inventory', async () => {
  const f = fixture(),
    request = await f.connect()
  const result = await f.capability.projectMetadata(f.owner, request)
  expect(result).toMatchObject({
    ok: true,
    value: { rows: [native], status, setupRunning: false, exposures: [] },
  })
  expect(f.cli.inventory).not.toHaveBeenCalled()
})

it('joins only actual referenced owned source metadata when managed copies are browsed first, including pending versions', async () => {
  const copy = {
    id: 'lib-guide',
    skillId: 'lib/guide',
    target: localPath('/workspace/.agents/skills/lib-guide'),
    mode: 'native',
    status: 'source_unverified',
  }
  const f = fixture([copy]),
    request = await f.connect()
  const result = await f.capability.projectMetadata(f.owner, request)
  expect(f.cli.inventory).toHaveBeenCalledExactlyOnceWith(
    selection,
    expect.any(AbortSignal),
  )
  expect(result).toMatchObject({
    ok: true,
    value: { rows: [native, canonical], exposures: [copy] },
  })
  if (!result.ok) throw Error(result.message)
  expect(result.value.rows.some((row) => row.id === 'lib/unrelated')).toBe(false)
  expect(result.value.rows[0]?.source.ownership).toBe('external')
  expect(result.value.rows[1]?.source).toMatchObject({
    ownership: 'library',
    libraryId: selection.library.id,
  })
})

it('keeps only the newest project read while an aborted predecessor is still closing', async () => {
  const f = fixture(),
    request = await f.connect()
  let close!: () => void
  let enter!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    enter = resolve
  })
  vi.mocked(f.project.projectMetadata).mockImplementationOnce(
    async (_selection, _root, _agent, signal) => {
      enter()
      await new Promise<void>((resolve) => {
        close = resolve
      })
      expect(signal.aborted).toBe(true)
      throw new SkillagerError('cancelled', 'Cancelled')
    },
  )
  const first = f.capability.projectMetadata(f.owner, request)
  await firstStarted
  const replaced = f.capability.projectMetadata(f.owner, { ...request, requestId: 2 })
  const latest = f.capability.projectMetadata(f.owner, { ...request, requestId: 3 })
  expect(f.project.projectMetadata).toHaveBeenCalledOnce()
  close()
  expect(await first).toMatchObject({ ok: false, reason: 'cancelled' })
  expect(await replaced).toMatchObject({ ok: false, reason: 'cancelled' })
  expect(await latest).toMatchObject({ ok: true })
  expect(f.project.projectMetadata).toHaveBeenCalledTimes(2)
})

it('fails explicitly if project metadata plus referenced canonical sources exceed the retained row bound', async () => {
  const f = fixture([
    {
      id: 'copy',
      skillId: canonical.id,
      target: localPath('/workspace/.agents/skills/lib-guide'),
      mode: 'native',
      status: 'current',
    },
  ])
  const request = await f.connect()
  vi.mocked(f.project.projectMetadata).mockResolvedValue({
    rows: Array.from({ length: 10_000 }, (_, index) => ({
      ...native,
      id: `project/${index}`,
    })),
    status,
  })
  expect(await f.capability.projectMetadata(f.owner, request)).toMatchObject({
    ok: false,
    reason: 'output-limit',
  })
})

it('revokes project reads on disable and does not publish completed obsolete metadata', async () => {
  const f = fixture(),
    request = await f.connect()
  let close!: () => void
  vi.mocked(f.project.projectMetadata).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      close = resolve
    })
    return { rows: [native], status }
  })
  const reading = f.capability.projectMetadata(f.owner, request)
  f.capability.configure(f.owner, false)
  close()
  expect(await reading).toMatchObject({ ok: false, reason: 'cancelled' })
  expect(await f.capability.projectMetadata(f.owner, request)).toMatchObject({
    ok: false,
    reason: 'disabled',
  })
})
