import type { BrowserWindow } from 'electron'
import { createSkillagerFolderPicker } from '../src/main/skillager/electron-skillager-folder-picker'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import type {
  SkillagerInitialization,
  SkillagerSetupCliPort,
} from '../src/main/skillager/skillager-setup-port'
import {
  exposureResponse,
  request as exposureRequest,
} from './fixtures/skillager-exposure-fixture'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import type { ExecResult } from '../src/shared'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import { SkillagerCapability } from '../src/main/skillager/skillager-capability'
import type { SkillagerCliPort } from '../src/main/skillager/skillager-port'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { SkillagerRequest, SkillagerSearchRequest } from '../src/shared/skillager'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

const root = localPath('/workspace')
const selection = {
  executable: localPath('/tools/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.0',
  environment: {},
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}

function fixture(
  overrides: Partial<SkillagerCliPort> = {},
  review?: ConstructorParameters<typeof SkillagerCapability>[3],
  exposure?: Omit<ConstructorParameters<typeof SkillagerCapability>[4], 'observe'>,
  setup?: ConstructorParameters<typeof SkillagerCapability>[5],
) {
  const resources = createRendererResourceFixture()
  const owner = resources.activateOwner()
  const calls = {
    probe: vi.fn(() => Promise.resolve(selection)),
    validate: vi.fn(() => Promise.resolve()),
    inventory: vi.fn(() => Promise.resolve([])),
    search: vi.fn(() => Promise.resolve([])),
    exposures: vi.fn(() => Promise.resolve([])),
  }
  const cli: SkillagerCliPort = { ...calls, ...overrides }
  let available = true
  const capability = new SkillagerCapability(
    cli,
    resources.scopes,
    () => available,
    review ?? {
      cli: {
        review: vi.fn(() => Promise.reject(new Error('Unexpected content review'))),
        history: vi.fn(() => Promise.reject(new Error('Unexpected version history'))),
        diff: vi.fn(() => Promise.reject(new Error('Unexpected content diff'))),
        accept: vi.fn(() => Promise.reject(new Error('Unexpected acceptance'))),
      },
      previews: {
        create: vi.fn(() => {
          throw new Error('Unexpected HTML preview')
        }),
        release: vi.fn(),
      },
    },
    {
      observe: (selection, request, _source, signal) =>
        cli.exposures(selection, request, signal),
      ...(exposure ?? {
        cli: {
          updateSourceHash: vi.fn(() =>
            Promise.reject(new Error('Unexpected update status')),
          ),
          previewExposure: vi.fn(() =>
            Promise.reject(new Error('Unexpected exposure preview')),
          ),
          applyExposure: vi.fn(() =>
            Promise.reject(new Error('Unexpected exposure apply')),
          ),
        },
        destinationAvailable: () => available,
      }),
    },
    setup ?? {
      cli: {
        defaultLibraryRoot: () =>
          Promise.resolve(localPath('/home/test/.skillager/library')),
        initializeLibrary: () => Promise.reject(new Error('Unexpected library creation')),
        libraryStatus: () =>
          Promise.reject(new Error('Unexpected library reconciliation')),
      },
      picker: { choose: () => Promise.reject(new Error('Unexpected native picker')) },
    },
  )
  onTestFinished(() => capability.dispose())
  async function connect() {
    capability.configure(owner, true)
    const probe = await capability.probe(owner)
    if (!probe.ok) throw new Error(probe.message)
    const connected = await capability.connect(owner, probe.value.probeId)
    if (!connected.ok) throw new Error(connected.message)
    return {
      connectionId: connected.value.connectionId,
      requestId: 1,
      workspaceRoot: root,
      agent: 'codex' as const,
    }
  }
  return {
    capability,
    resources,
    owner,
    cli,
    calls,
    connect,
    unavailable: () => {
      available = false
    },
  }
}
function search(request: SkillagerRequest, requestId = 1): SkillagerSearchRequest {
  return { ...request, requestId, query: `query-${requestId}`, scope: 'library' }
}
async function settle() {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}

function closingProcesses() {
  const running: Array<{ query: string; signal?: AbortSignal; close: () => void }> = []
  const runner = new SkillagerProcess({
    exec: (_command: string, args: readonly string[], options?: ExecOptions) =>
      new Promise<ExecResult>((resolve, reject) => {
        running.push({
          query: args[0]!,
          signal: options?.signal,
          close: () =>
            options?.signal?.aborted
              ? reject(new Error('aborted after close'))
              : resolve({ code: 0, signal: null, stdout: '[]', stderr: '' }),
        })
      }),
  })
  onTestFinished(() => runner.dispose())
  const run = async (query: string, signal: AbortSignal) => {
    await runner.run(
      'skillager',
      [query],
      { signal },
      { stdout: 1000, stderr: 100, deadlineMs: 5000 },
    )
    return []
  }
  return { running, runner, run }
}

describe('Skillager capability authority and demand', () => {
  it('awaits retained review cleanup when the renderer capability is revoked', async () => {
    let finish!: () => void
    const f = fixture(
      {},
      {
        cli: {
          review: () =>
            Promise.resolve({
              detail: {
                skillId: 'lib/example',
                root: localPath('/library/skills/example'),
                hash: 'a'.repeat(64),
                canAccept: true,
                files: [],
                findings: [],
                scanRisk: 'low',
                lintStatus: 'ok',
                history: { available: false, versions: [] },
              },
              bytes: new Map(),
              confirmationToken: 'private',
              dispose: () =>
                new Promise<void>((resolve) => {
                  finish = resolve
                }),
            }),
          history: () => Promise.resolve({ available: false, versions: [] }),
          diff: () => Promise.resolve({ toHash: 'a'.repeat(64), text: '' }),
          accept: () => Promise.resolve({ status: 'accepted', hash: 'a'.repeat(64) }),
        },
        previews: {
          create: () => ({ id: 'html', url: 'hvir-preview://document/html/index.html' }),
          release: () => undefined,
        },
      },
    )
    const request = await f.connect()
    const review = await f.capability.review(f.owner, {
      ...request,
      skillId: 'lib/example',
    })
    expect(review.ok).toBe(true)
    let completed = false
    const closing = f.capability.revoke(f.owner).then(() => {
      completed = true
    })
    await settle()
    expect(completed).toBe(false)
    finish()
    await closing
    expect(completed).toBe(true)
  })
  it('does no work while disabled or before explicit connection', async () => {
    const f = fixture()
    expect(await f.capability.probe(f.owner)).toMatchObject({
      ok: false,
      reason: 'disabled',
    })
    expect(f.calls.probe).not.toHaveBeenCalled()
    f.capability.configure(f.owner, true)
    const probe = await f.capability.probe(f.owner)
    expect(probe.ok).toBe(true)
    expect(f.calls.inventory).not.toHaveBeenCalled()
    expect(f.calls.search).not.toHaveBeenCalled()
    expect(
      await f.capability.inventory(f.owner, {
        connectionId: 'forged',
        requestId: 1,
        workspaceRoot: root,
        agent: 'codex',
      }),
    ).toMatchObject({ ok: false, reason: 'disconnected' })
    expect(f.calls.inventory).not.toHaveBeenCalled()
  })
  it('keeps only the latest replacement behind an exiting predecessor while inventory owns the other slot', async () => {
    const processes = closingProcesses()
    const f = fixture({
      search: (_selection, request, signal) => processes.run(request.query, signal),
      inventory: (_selection, signal) => processes.run('inventory', signal),
    })
    const request = await f.connect()
    const inventory = f.capability.inventory(f.owner, request)
    const first = f.capability.search(f.owner, search(request))
    const replaced = f.capability.search(f.owner, search(request, 2))
    const newest = f.capability.search(f.owner, search(request, 3))
    expect(processes.running.map((item) => item.query)).toEqual(['inventory', 'query-1'])
    expect(processes.running[1]?.signal?.aborted).toBe(true)
    expect(await replaced).toMatchObject({ ok: false, reason: 'cancelled' })
    processes.running[1]!.close()
    await settle()
    expect(await first).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(processes.running.map((item) => item.query)).toEqual([
      'inventory',
      'query-1',
      'query-3',
    ])
    processes.running[2]!.close()
    processes.running[0]!.close()
    expect(await newest).toMatchObject({ ok: true, value: { rows: [] } })
    expect(await inventory).toMatchObject({ ok: true })
  })
  it.each(['disable', 'workspace', 'renderer', 'dispose'] as const)(
    'revokes %s demand and awaits the actual host close',
    async (kind) => {
      const processes = closingProcesses()
      const f = fixture({
        search: (_selection, request, signal) => processes.run(request.query, signal),
      })
      const request = await f.connect()
      const pending = f.capability.search(f.owner, search(request))
      let released = false
      let cleanup: Promise<unknown>
      if (kind === 'disable') {
        f.capability.configure(f.owner, false)
        cleanup = f.capability.dispose()
      } else if (kind === 'workspace') cleanup = f.resources.scopes.revokeWorkspace(root)
      else if (kind === 'renderer') cleanup = f.resources.destroyOwner(f.owner.id)
      else cleanup = f.capability.dispose()
      void cleanup.then(() => {
        released = true
      })
      await settle()
      expect(processes.running[0]?.signal?.aborted).toBe(true)
      expect(released).toBe(false)
      processes.running[0]!.close()
      expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
      await cleanup
      expect(released).toBe(true)
    },
  )
  it('rejects remote workspace discovery, unavailable roots and invalid queries before CLI search', async () => {
    const f = fixture()
    const request = await f.connect()
    expect(
      await f.capability.search(f.owner, {
        ...search(request),
        scope: 'workspace',
        workspaceRoot: hostPath(asHostId('ssh'), '/remote'),
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(
      await f.capability.search(f.owner, {
        ...search(request, 2),
        query: 'é'.repeat(501),
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    f.unavailable()
    expect(await f.capability.search(f.owner, search(request, 3))).toMatchObject({
      ok: false,
      reason: 'invalid-request',
    })
    expect(f.calls.search).not.toHaveBeenCalled()
  })
  it('keeps failure distinct from successful empty output', async () => {
    const f = fixture({
      inventory: () => Promise.reject(new Error('PRIVATE CLI DUMP')),
    })
    const request = await f.connect()
    expect(await f.capability.inventory(f.owner, request)).toEqual({
      ok: false,
      reason: 'command-failed',
      message: 'Skillager request failed. Try again.',
    })
    expect(await f.capability.search(f.owner, search(request))).toMatchObject({
      ok: true,
      value: { rows: [] },
    })
  })
  it('classifies a late probe after owner revocation as cancelled', async () => {
    let finish!: (value: typeof selection) => void
    const f = fixture({
      probe: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    f.capability.configure(f.owner, true)
    const pending = f.capability.probe(f.owner)
    const revoked = f.resources.destroyOwner(f.owner.id)
    finish(selection)
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    await revoked
    expect(await f.capability.probe(f.owner)).toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
  })
  it('reports unexpected resource-registration failure without blaming CLI metadata or exposing diagnostics', async () => {
    const f = fixture()
    const request = await f.connect()
    vi.spyOn(f.resources.scopes, 'register').mockImplementationOnce(() => {
      throw new Error('PRIVATE RESOURCE DUMP')
    })
    expect(await f.capability.inventory(f.owner, request)).toEqual({
      ok: false,
      reason: 'command-failed',
      message: 'Skillager request failed. Try again.',
    })
  })
  it('keeps operational rejections during owner revocation cancelled', async () => {
    let fail!: (error: unknown) => void
    const f = fixture({
      search: () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    })
    const request = await f.connect()
    const pending = f.capability.search(f.owner, search(request))
    const revoked = f.resources.destroyOwner(f.owner.id)
    fail(new Error('PRIVATE ABORT FAILURE'))
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    await revoked
  })
})

function updateFixture() {
  const request: SkillagerExposureRequest = {
    ...exposureRequest,
    workspaceRoot: root,
    destination: { projectId: 'project', workspaceId: 'workspace', root },
    action: 'update',
    exposure: {
      id: 'lib-demo',
      skillId: 'lib/demo',
      mode: 'native',
      status: 'source_update',
      target: localPath('/workspace/.agents/skills/lib-demo'),
    },
  }
  let targetHash = 'a'.repeat(64)
  const previewExposure = vi.fn((_selection, at: SkillagerExposureRequest) => {
    const parsed = parseExposurePreview(
      exposureResponse({ ...at, action: 'change' }).value,
      selection,
      at,
    )
    return Promise.resolve({ ...parsed, detail: { ...parsed.detail, targetHash } })
  })
  const review = vi.fn(() =>
    Promise.resolve({
      detail: {
        skillId: request.skillId,
        root: localPath('/library/skills/demo'),
        hash: 'a'.repeat(64),
        files: [],
        canAccept: false,
        scanRisk: 'low',
        lintStatus: 'ok',
        findings: [],
        history: { available: true, versions: [] },
      },
      bytes: new Map(),
      dispose: vi.fn(() => Promise.resolve()),
    }),
  )
  const applyExposure = vi.fn()
  const f = fixture(
    {},
    {
      cli: {
        review,
        history: vi.fn(),
        accept: vi.fn(),
        diff: vi.fn(() =>
          Promise.resolve({
            fromHash: 'c'.repeat(64),
            toHash: 'a'.repeat(64),
            text: '+ reviewed',
          }),
        ),
      },
      previews: { create: vi.fn(), release: vi.fn() },
    },
    {
      cli: {
        previewExposure,
        updateSourceHash: vi.fn(() => Promise.resolve('c'.repeat(64))),
        applyExposure,
      },
      destinationAvailable: (destination) =>
        destination.workspaceId === 'workspace' && destination.projectId === 'project',
    },
  )
  return {
    ...f,
    request,
    review,
    previewExposure,
    applyExposure,
    changeTarget: () => {
      targetHash = 'd'.repeat(64)
    },
  }
}
it.each([
  { action: 'change' },
  { skillId: 'lib/other' },
  { connectionId: 'other' },
  { agent: 'claude' },
  { workspaceRoot: localPath('/other') },
  {
    destination: {
      projectId: 'project',
      workspaceId: 'workspace',
      root: localPath('/other'),
    },
  },
  { destination: { projectId: 'project', workspaceId: 'closed', root } },
  { mode: 'stub' },
  { exposure: undefined },
] as const)(
  'rejects mismatched nested update selection before review work: %j',
  async (patch) => {
    const f = updateFixture(),
      base = await f.connect()
    const update = { ...f.request, ...base, ...patch } as SkillagerExposureRequest
    expect(
      await f.capability.review(f.owner, { ...base, skillId: f.request.skillId, update }),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(f.previewExposure).not.toHaveBeenCalled()
    expect(f.review).not.toHaveBeenCalled()
  },
)
it('consults the retained update proof through capability preview and rechecks it at apply', async () => {
  const f = updateFixture(),
    base = await f.connect(),
    request = { ...f.request, ...base }
  for (const reviewId of [undefined, 'forged'])
    expect(
      await f.capability.previewExposure(f.owner, { ...request, reviewId }),
    ).toMatchObject({ ok: false })
  expect(f.previewExposure).not.toHaveBeenCalled()
  const reviewed = await f.capability.review(f.owner, {
    ...base,
    skillId: request.skillId,
    update: request,
  })
  if (!reviewed.ok) throw new Error(reviewed.message)
  const linked = { ...request, reviewId: reviewed.value.reviewId }
  const preview = await f.capability.previewExposure(f.owner, linked)
  if (!preview.ok) throw new Error(preview.message)
  await f.capability.releaseReview(f.owner, reviewed.value.reviewId)
  expect(
    await f.capability.applyExposure(f.owner, preview.value.previewId),
  ).toMatchObject({ ok: false })
  expect(f.applyExposure).not.toHaveBeenCalled()
})
it('validates later CLI target evidence through the capability update grant', async () => {
  const f = updateFixture(),
    base = await f.connect(),
    request = { ...f.request, ...base }
  const reviewed = await f.capability.review(f.owner, {
    ...base,
    skillId: request.skillId,
    update: request,
  })
  if (!reviewed.ok) throw new Error(reviewed.message)
  f.changeTarget()
  expect(
    await f.capability.previewExposure(f.owner, {
      ...request,
      reviewId: reviewed.value.reviewId,
    }),
  ).toMatchObject({ ok: false, reason: 'stale-review' })
  expect(f.previewExposure).toHaveBeenCalledTimes(2)
  expect(f.applyExposure).not.toHaveBeenCalled()
})

function setupFixture() {
  const target = localPath('/home/test/.skillager/library')
  const status = {
    library: {
      ...selection.library,
      root: target,
      skillsRoot: localPath(target.path + '/skills'),
    },
    gitHistory: true,
  }
  const init = vi.fn(
    (
      _selection: unknown,
      _root: unknown,
      _git: boolean,
      _signal: AbortSignal,
    ): Promise<SkillagerInitialization> => Promise.resolve({ kind: 'ready', status }),
  )
  const observed = vi.fn<SkillagerSetupCliPort['libraryStatus']>(() =>
    Promise.resolve(status),
  )
  const defaultRoot = vi.fn(() => Promise.resolve(target))
  const picker = vi.fn<
    ConstructorParameters<typeof SkillagerCapability>[5]['picker']['choose']
  >(() => Promise.resolve(undefined))
  const f = fixture(
    { probe: () => Promise.resolve({ ...selection, library: undefined }) },
    undefined,
    undefined,
    {
      cli: {
        defaultLibraryRoot: defaultRoot,
        initializeLibrary: init,
        libraryStatus: observed,
      },
      picker: { choose: picker },
    },
  )
  async function offer(owner = f.owner) {
    f.capability.configure(owner, true)
    const result = await f.capability.probe(owner)
    if (!result.ok || !result.value.setup?.target) throw Error('Missing setup offer')
    return result.value
  }
  return { ...f, init, observed, defaultRoot, picker, offer, target, status }
}

describe('explicit personal-library initialization', () => {
  it.each([
    [
      new SkillagerError('unsupported', 'No supported local home directory.'),
      'No supported local home directory.',
    ],
    [
      new Error('PRIVATE filesystem diagnostic'),
      'The local library location could not be determined. Check Skillager again.',
    ],
  ])(
    'preserves compatible CLI diagnostics when the default location fails (%s)',
    async (error, message) => {
      const f = setupFixture()
      f.defaultRoot.mockRejectedValueOnce(error)
      f.capability.configure(f.owner, true)
      const probed = await f.capability.probe(f.owner)
      expect(probed).toMatchObject({
        ok: true,
        value: {
          executable: selection.executable,
          version: selection.version,
          library: undefined,
          setup: { target: undefined, needsReconciliation: false, message },
        },
      })
      expect(JSON.stringify(probed)).not.toContain('PRIVATE')
      if (!probed.ok) throw Error('Expected compatible CLI diagnostics')
      expect(
        await f.capability.initializeLibrary(f.owner, 'ungranted', true),
      ).toMatchObject({ ok: false, reason: 'invalid-request' })
      expect(
        await f.capability.chooseLibraryFolder(f.owner, probed.value.probeId),
      ).toMatchObject({ ok: false })
      expect(f.init).not.toHaveBeenCalled()
      expect(f.picker).not.toHaveBeenCalled()
    },
  )

  it('does not publish compatible CLI diagnostics when default derivation rejects after revocation', async () => {
    const f = setupFixture()
    let reject!: (error: Error) => void
    let started!: () => void
    const deriving = new Promise<void>((resolve) => {
      started = resolve
    })
    f.defaultRoot.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
          started()
        }),
    )
    f.capability.configure(f.owner, true)
    const pending = f.capability.probe(f.owner)
    await deriving
    f.capability.configure(f.owner, false)
    reject(new SkillagerError('unsupported', 'No supported local home directory.'))
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(f.init).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'creates only the retained local selection with explicit Git=%s and connects matching metadata directly',
    async (gitHistory) => {
      const f = setupFixture(),
        offer = await f.offer()
      expect(f.init).not.toHaveBeenCalled()
      expect(f.observed).not.toHaveBeenCalled()
      f.init.mockResolvedValue({ kind: 'ready', status: { ...f.status, gitHistory } })
      const result = await f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        gitHistory,
      )
      expect(result).toMatchObject({
        ok: true,
        value: {
          connection: { library: f.status.library },
          probe: { setup: { gitHistory, needsReconciliation: false } },
        },
      })
      expect(f.init).toHaveBeenCalledWith(
        expect.objectContaining({ catalog: selection.catalog }),
        f.target,
        gitHistory,
        expect.any(AbortSignal),
      )
      expect(f.observed).not.toHaveBeenCalled()
    },
  )

  it('native cancellation preserves selection, and choosing another folder invalidates its previous handle', async () => {
    const f = setupFixture(),
      offer = await f.offer()
    expect(await f.capability.chooseLibraryFolder(f.owner, offer.probeId)).toMatchObject({
      ok: true,
      value: { setup: offer.setup },
    })
    const chosen = localPath('/chosen personal library')
    f.picker.mockResolvedValue(chosen)
    const next = await f.capability.chooseLibraryFolder(f.owner, offer.probeId)
    expect(next).toMatchObject({
      ok: true,
      value: { setup: { target: { root: chosen } } },
    })
    expect(
      await f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        true,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(f.init).not.toHaveBeenCalled()
  })

  it('rejects remote and stale picker results without restoring the selection', async () => {
    const f = setupFixture(),
      offer = await f.offer()
    f.picker.mockResolvedValue(hostPath(asHostId('ssh:fixture'), '/remote'))
    expect(await f.capability.chooseLibraryFolder(f.owner, offer.probeId)).toMatchObject({
      ok: false,
      reason: 'invalid-request',
    })
    let resolve!: (value: ReturnType<typeof localPath>) => void
    f.picker.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const pending = f.capability.chooseLibraryFolder(f.owner, offer.probeId)
    await f.capability.probe(f.owner)
    resolve(localPath('/late'))
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(f.init).not.toHaveBeenCalled()
  })

  it('shows actual Git mode and requires a new explicit connection when an existing library differs', async () => {
    const f = setupFixture(),
      offer = await f.offer()
    const initialized = await f.capability.initializeLibrary(
      f.owner,
      offer.setup!.target!.selectionId,
      false,
    )
    expect(initialized).toMatchObject({
      ok: true,
      value: { probe: { library: f.status.library, setup: { gitHistory: true } } },
    })
    if (!initialized.ok) throw Error('Expected verified mismatch')
    expect(initialized.value.connection).toBeUndefined()
    expect(
      await f.capability.connect(f.owner, initialized.value.probe.probeId),
    ).toMatchObject({ ok: true })
    expect(
      await f.capability.reconcileLibrary(f.owner, initialized.value.probe.probeId),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(f.observed).not.toHaveBeenCalled()
  })

  it.each([
    ['disable', true],
    ['renderer', true],
    ['disable', false],
    ['renderer', false],
  ] as const)(
    'retains attempted root, admission and uncertainty across %s until explicit reconciliation (registered=%s)',
    async (boundary, registered) => {
      const f = setupFixture(),
        initial = await f.offer(),
        chosen = localPath('/chosen personal library')
      f.picker.mockResolvedValueOnce(chosen)
      const picked = await f.capability.chooseLibraryFolder(f.owner, initial.probeId)
      if (!picked.ok) throw Error('Expected chosen library')
      const offer = picked.value
      let close!: (value: SkillagerInitialization) => void
      f.init.mockImplementation(
        () =>
          new Promise((resolve) => {
            close = resolve
          }),
      )
      const creation = f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        true,
      )
      expect(
        await f.capability.initializeLibrary(
          f.owner,
          offer.setup!.target!.selectionId,
          true,
        ),
      ).toMatchObject({ ok: false, reason: 'busy' })
      let currentOwner = f.owner
      if (boundary === 'disable') f.capability.configure(f.owner, false)
      else currentOwner = f.resources.rolloverOwner(f.owner.id).owner
      const next = await f.offer(currentOwner)
      expect(f.init.mock.calls[0]![3].aborted).toBe(true)
      expect(next.setup?.needsReconciliation).toBe(true)
      expect(next.setup?.target?.root).toEqual(chosen)
      expect(f.defaultRoot).toHaveBeenCalledOnce()
      expect(
        await f.capability.initializeLibrary(
          currentOwner,
          next.setup!.target!.selectionId,
          true,
        ),
      ).toMatchObject({ ok: false, reason: 'busy' })
      close({ kind: 'ready', status: f.status })
      expect(await creation).toMatchObject({ ok: false, reason: 'cancelled' })
      expect(
        await f.capability.initializeLibrary(
          currentOwner,
          next.setup!.target!.selectionId,
          true,
        ),
      ).toMatchObject({ ok: false, reason: 'uncertain' })
      f.observed.mockRejectedValueOnce(
        new SkillagerError('unavailable', 'Unavailable status'),
      )
      expect(
        await f.capability.reconcileLibrary(currentOwner, next.probeId),
      ).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(
        await f.capability.initializeLibrary(
          currentOwner,
          next.setup!.target!.selectionId,
          true,
        ),
      ).toMatchObject({ ok: false, reason: 'uncertain' })
      if (!registered) f.observed.mockResolvedValueOnce({})
      f.defaultRoot.mockRejectedValue(
        new SkillagerError('unsupported', 'Default unavailable'),
      )
      const checked = await f.capability.reconcileLibrary(currentOwner, next.probeId)
      expect(checked).toMatchObject({
        ok: true,
        value: {
          library: registered ? f.status.library : undefined,
          setup: { needsReconciliation: false },
        },
      })
      expect(f.init).toHaveBeenCalledOnce()
      expect(f.defaultRoot).toHaveBeenCalledOnce()
      if (!checked.ok) throw Error('Expected observed library')
      if (registered) {
        expect(
          await f.capability.connect(currentOwner, checked.value.probeId),
        ).toMatchObject({ ok: true })
      } else {
        expect(checked.value.setup?.target?.root).toEqual(chosen)
        expect(checked.value.setup?.message).toContain(
          'Files from an interrupted setup may still exist at the selected location.',
        )
        f.init.mockResolvedValueOnce({
          kind: 'ready',
          status: {
            ...f.status,
            library: {
              ...f.status.library,
              root: chosen,
              skillsRoot: localPath(chosen.path + '/skills'),
            },
          },
        })
        expect(
          await f.capability.initializeLibrary(
            currentOwner,
            checked.value.setup!.target!.selectionId,
            false,
          ),
        ).toMatchObject({ ok: true })
        expect(f.init.mock.calls[1]![1]).toEqual(chosen)
      }
    },
  )

  it.each([
    ['timeout', 'Skillager took too long while setting up'],
    ['output-limit', 'exceeded the supported size'],
    ['malformed-result', 'Invalid bounded setup response'],
  ] as const)(
    'preserves actionable %s context while requiring reconciliation',
    async (reason, message) => {
      const f = setupFixture(),
        offer = await f.offer()
      f.init.mockRejectedValueOnce(
        new SkillagerError(
          reason,
          reason === 'malformed-result' ? message : 'Read request failed. Try again.',
        ),
      )
      const result = await f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        true,
      )
      expect(result).toMatchObject({
        ok: false,
        reason: 'uncertain',
      })
      if (result.ok) throw Error('Expected uncertain setup')
      expect(result.message).toContain(message)
      expect(JSON.stringify(result)).not.toContain('Try again')
      expect(
        await f.capability.initializeLibrary(
          f.owner,
          offer.setup!.target!.selectionId,
          true,
        ),
      ).toMatchObject({ ok: false, reason: 'uncertain' })
    },
  )

  it('known pre-execution refusal stays distinct and does not require reconciliation', async () => {
    const f = setupFixture(),
      offer = await f.offer()
    f.init.mockResolvedValueOnce({
      kind: 'refused',
      message: 'Git is unavailable. Choose whether to keep history.',
    })
    expect(
      await f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        true,
      ),
    ).toMatchObject({ ok: false, reason: 'command-failed' })
    expect(
      await f.capability.initializeLibrary(
        f.owner,
        offer.setup!.target!.selectionId,
        true,
      ),
    ).toMatchObject({ ok: true })
    expect(f.observed).not.toHaveBeenCalled()
  })
})

it('renderer revocation and application disposal settle without awaiting an undismissed native chooser', async () => {
  const f = setupFixture(),
    offer = await f.offer()
  const realpath = vi.fn(() => Promise.reject(Error('Unexpected late filesystem read')))
  const native = createSkillagerFolderPicker(
    { realpath },
    {
      showOpenDialog: () => new Promise(() => {}),
    },
    () => ({}) as BrowserWindow,
  )
  f.picker.mockImplementation((owner, root, signal) => native.choose(owner, root, signal))
  const pending = f.capability.chooseLibraryFolder(f.owner, offer.probeId)
  await f.capability.revoke(f.owner)
  expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
  await f.capability.dispose()
  expect(realpath).not.toHaveBeenCalled()
})

it('changing executable/environment aliases cannot clear uncertainty for the canonical catalog identity', async () => {
  const f = setupFixture(),
    offered = await f.offer()
  f.init.mockRejectedValueOnce(
    new SkillagerError('malformed-result', 'Setup result was invalid.'),
  )
  await f.capability.initializeLibrary(f.owner, offered.setup!.target!.selectionId, true)
  // The CLI port canonicalizes both environment aliases to the same catalog.
  f.cli.probe = () =>
    Promise.resolve({
      ...selection,
      library: undefined,
      executable: localPath('/other/skillager'),
      environment: { SKILLAGER_CATALOG_STATE_DIR: '/catalog-symlink' },
    })
  const reprobed = await f.capability.probe(f.owner, localPath('/other/skillager'))
  if (!reprobed.ok) throw Error('Expected compatible reprobe')
  expect(reprobed.value.setup?.needsReconciliation).toBe(true)
  expect(
    await f.capability.initializeLibrary(
      f.owner,
      reprobed.value.setup!.target!.selectionId,
      true,
    ),
  ).toMatchObject({ ok: false, reason: 'uncertain' })
  expect(f.init).toHaveBeenCalledOnce()
  expect(f.observed).not.toHaveBeenCalled()
})
