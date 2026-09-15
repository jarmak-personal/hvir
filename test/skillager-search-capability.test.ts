import { expect, it, onTestFinished, vi } from 'vitest'
import { SkillagerCapability } from '../src/main/skillager/skillager-capability'
import type { SkillagerCliPort } from '../src/main/skillager/skillager-port'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { SkillagerWorkspaceExposure } from '../src/shared/skillager'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import { skillagerSearchResult, searchLibrary } from './fixtures/skillager-search-fixture'

function fixture(supported = true) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const selection = {
    executable: localPath('/tools/skillager'),
    catalog: localPath('/catalog'),
    version: 'fixture',
    environment: {},
    library: searchLibrary,
    searchView: supported ? ('skillager.search.v1' as const) : undefined,
  }
  const unexpected = () => Promise.reject(Error('Unexpected non-search operation'))
  const observe = vi.fn<ConstructorParameters<typeof SkillagerCapability>[4]['observe']>(
    () => Promise.resolve([]),
  )
  const search = vi.fn<SkillagerCliPort['search']>((_selection, request) =>
    supported || request.view === 'legacy'
      ? Promise.resolve(skillagerSearchResult(request))
      : Promise.reject(
          new SkillagerError('search-unsupported', 'Unsupported search view.'),
        ),
  )
  const capability = new SkillagerCapability(
    {
      probe: () => Promise.resolve(selection),
      validate: () => Promise.resolve(),
      inventory: unexpected,
      exposures: unexpected,
      search,
      syncStatus: unexpected,
      documentAccess: unexpected,
      validateDocument: unexpected,
      syncApproved: unexpected,
    },
    resources.scopes,
    () => true,
    {
      cli: {
        review: unexpected,
        history: unexpected,
        diff: unexpected,
        accept: unexpected,
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
        updateSourceHash: unexpected,
        previewExposure: unexpected,
        applyExposure: unexpected,
      },
      observe,
      destinationAvailable: () => true,
    },
    {
      cli: {
        defaultLibraryRoot: unexpected,
        initializeLibrary: unexpected,
        libraryStatus: unexpected,
      },
      picker: { choose: unexpected },
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
      workspaceRoot: hostPath(asHostId('ssh:fixture'), '/workspace'),
      agent: 'claude' as const,
      scope: 'library' as const,
      query: 'merge',
    }
  }
  return { capability, owner, observe, search, connect }
}

it('observes all recorded agents once before a remote query and returns that exact observation', async () => {
  const f = fixture(),
    request = await f.connect()
  let release!: (value: readonly SkillagerWorkspaceExposure[]) => void
  let started!: () => void
  const observing = new Promise<void>((resolve) => {
    started = resolve
  })
  f.observe.mockImplementation(() => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const pending = f.capability.search(f.owner, request)
  await observing
  expect(f.search).not.toHaveBeenCalled()
  expect(f.observe.mock.calls[0]?.[1]).toMatchObject({
    agent: 'claude',
    browseAgent: 'all',
  })
  expect(f.observe.mock.calls[0]?.[2]).toEqual({ rows: [], complete: false })
  const exposures: SkillagerWorkspaceExposure[] = [
    {
      id: 'recorded',
      agent: 'codex',
      target: hostPath(asHostId('ssh:fixture'), '/workspace/skill'),
      mode: 'native',
      status: 'local_edit',
      skillId: 'lib/merge',
      sourceLibraryId: searchLibrary.id,
    },
  ]
  release(exposures)
  const result = await pending
  expect(f.search.mock.calls[0]?.[3]).toEqual({ exposures })
  expect(result).toMatchObject({ ok: true, value: { exposures } })
  expect(f.observe).toHaveBeenCalledTimes(1)
})

it('does not start a query from a late recorded observation after disable and awaits its closure', async () => {
  const f = fixture(),
    request = await f.connect()
  let release!: (value: readonly SkillagerWorkspaceExposure[]) => void
  let started!: () => void
  const observing = new Promise<void>((resolve) => {
    started = resolve
  })
  f.observe.mockImplementation(() => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const pending = f.capability.search(f.owner, request)
  await observing
  const signal = f.observe.mock.calls[0]![3]
  f.capability.configure(f.owner, false)
  expect(signal.aborted).toBe(true)
  let disposed = false
  const disposal = f.capability.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release([])
  expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
  expect(f.search).not.toHaveBeenCalled()
  await disposal
  expect(disposed).toBe(true)
})

it('does not observe remote deliveries for an unsupported default search', async () => {
  const f = fixture(false),
    request = await f.connect()
  expect(await f.capability.search(f.owner, request)).toMatchObject({
    ok: false,
    reason: 'search-unsupported',
  })
  expect(f.observe).not.toHaveBeenCalled()
})
