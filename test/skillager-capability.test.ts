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
