import { afterEach, expect, it, vi } from 'vitest'
import { sourceFixture } from './fixtures/extension-source'
import { localPath, asHostId, hostPath } from '../src/shared/host-path'
import type { AdmittedExtensionContext } from '../src/main/extensions/context-owner'
import { ExtensionSourceRequestOwner } from '../src/main/extensions/source-request'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { SOURCE_LIMITS } from '../src/shared/extensions/source-access'

const stop: (() => void)[] = []
afterEach(() => {
  for (const dispose of stop.splice(0)) dispose()
  vi.useRealTimers()
})
async function fixture() {
  const f = sourceFixture('workspace')
  const second = {
    id: 'second',
    name: 'Second',
    host: asHostId('local'),
    root: localPath('/second'),
  }
  f.workspaces.push(second)
  const stat = f.host.stat.getMockImplementation()!
  f.host.stat.mockImplementation((path) =>
    path.path === second.root.path
      ? Promise.resolve({ type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 })
      : stat(path),
  )
  const a = f.caller.context()!,
    b: AdmittedExtensionContext = {
      value: { surface: 'top', visible: true, workspace: second },
      root: second.root,
      current: () => true,
    }
  let selected = a
  const caller = { ...f.caller, context: () => selected }
  const scopes = new RendererResourceScopes(),
    renderer = scopes.activateOwner(1),
    publish = vi.fn()
  const requests = new ExtensionSourceRequestOwner(
    scopes,
    f.approvals,
    () => true,
    publish,
  )
  f.revoked.mockImplementation((id, source, binding, cancelRequests) => {
    f.reading.revoke(id, source, binding)
    if (cancelRequests) requests.revoke(id, source, binding)
    requests.revalidate()
  })
  stop.push(() => {
    requests.dispose()
    f.dispose()
  })
  await f.approvals.start()
  const grant = async (context: AdmittedExtensionContext) => {
    const prepared = await f.approvals.prepare(
      {
        installationId: 'installation',
        source: 'source',
        workspaceId: context.value.workspace!.id,
      },
      () => {},
    )
    await f.approvals.approve(prepared.token)
  }
  return {
    ...f,
    a,
    b,
    caller,
    requests,
    renderer,
    publish,
    grant,
    select: (context: AdmittedExtensionContext) => {
      selected = context
      requests.revalidate()
    },
    request: () => requests.request(caller, { source: 'source' }, renderer),
  }
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.requests.snapshot(f.renderer)[0]?.state).toBe('ready'))
  return f.requests.snapshot(f.renderer)[0]!
}
it('retains A and B across restart, reuses A→B→A without writes, and exposes only caller-local guest status', async () => {
  const f = await fixture()
  await f.grant(f.a)
  await f.grant(f.b)
  await f.approvals.start()
  expect(f.state()).toHaveLength(2)
  expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
  expect(
    f.approvals
      .status(f.activation)
      .every((entry) => !entry.granted && !entry.workspaceId),
  ).toBe(true)
  expect(f.approvals.settings(f.activation)).toHaveLength(2)
  const writes = f.authority.saveSourceGrants.mock.calls.length
  for (const context of [f.a, f.b, f.a]) {
    f.select(context)
    await expect(f.request()).resolves.toEqual({ granted: true })
    expect(f.approvals.status(f.activation, context)).toMatchObject([
      { granted: true, workspaceId: context.value.workspace!.id, root: context.root },
    ])
  }
  expect(f.authority.saveSourceGrants).toHaveBeenCalledTimes(writes)
  expect(f.publish).not.toHaveBeenCalled()
})
it('accepts source-only context from an explicitly targeted application view, and cancels retargeted consent', async () => {
  const f = await fixture()
  f.select(f.b)
  const request = f.request(),
    p = await ready(f)
  expect(p.reportedRoot).toEqual(f.b.root)
  f.requests.decide(f.renderer, p.id, true)
  await expect(request).resolves.toEqual({ granted: true })
  expect(f.approvals.get(f.activation, 'source', f.b)?.workspaceId).toBe('second')
  f.select(f.a)
  const abandoned = f.request(),
    rejected = expect(abandoned).rejects.toThrow(/ended/)
  await ready(f)
  f.select(f.b)
  await rejected
  expect(f.state()).toHaveLength(1)
  expect(f.requests.snapshot(f.renderer)).toEqual([])
})
it('refuses guest-selected roots/IDs, absent or mismatched host context and non-human requests without probing', async () => {
  const f = await fixture()
  for (const input of [
    { source: 'source', root: f.root },
    { source: 'source', workspaceId: 'second' },
  ])
    await expect(f.requests.request(f.caller, input, f.renderer)).rejects.toThrow()
  await expect(
    f.requests.request(
      { ...f.caller, context: () => undefined },
      { source: 'source' },
      f.renderer,
    ),
  ).rejects.toThrow(/main-admitted/)
  await expect(
    f.requests.request({ ...f.caller, allowed: false }, { source: 'source' }, f.renderer),
  ).rejects.toThrow(/human-selected/)
  expect(f.host.realpath).not.toHaveBeenCalled()
  await f.grant(f.a)
  const wrongHost = { ...f.a, root: hostPath(asHostId('ssh'), f.root.path) }
  expect(f.approvals.get(f.activation, 'source', wrongHost)).toBeUndefined()
})
it('revokes only B while A selected bytes and A preparation remain usable', async () => {
  const f = await fixture()
  await f.grant(f.a)
  await f.grant(f.b)
  const selected = (await f.reading.select(f.caller, {
    source: 'source',
    path: f.path,
  })) as { receipt: string }
  const aDecision = await f.approvals.prepare(
    { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
    () => {},
  )
  await f.approvals.revoke('installation', 'source', {
    workspaceId: 'second',
    root: f.b.root!,
  })
  expect(f.approvals.get(f.activation, 'source', f.a)).toBeDefined()
  expect(f.approvals.get(f.activation, 'source', f.b)).toBeUndefined()
  expect(f.approvals.hasPrepared(aDecision.token)).toBe(true)
  expect(
    f.reading.read(f.caller, { receipt: selected.receipt, offset: 0 }),
  ).toMatchObject({ data: '# Current instruction' })
  f.approvals.cancelPrepared(aDecision.token)
})
it('exact revocation cancels matching preparation before a token exists without ending A consent', async () => {
  const f = await fixture()
  const aRequest = f.request(),
    aProposal = await ready(f)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    reached = new Promise<void>((resolve) => {
      entered = resolve
    })
  const original = f.host.realpath.getMockImplementation()!
  f.host.realpath.mockImplementationOnce(async (path) => {
    entered()
    await held
    return original(path)
  })
  const bCaller = { ...f.caller, view: 'b-view', context: () => f.b }
  const bRequest = f.requests.request(bCaller, { source: 'source' }, f.renderer),
    rejection = expect(bRequest).rejects.toThrow(/revoked|ended/)
  await reached
  await f.approvals.revoke('installation', 'source', {
    workspaceId: 'second',
    root: f.b.root!,
  })
  expect(f.requests.snapshot(f.renderer).map((entry) => entry.id)).toEqual([aProposal.id])
  release()
  await rejection
  f.requests.decide(f.renderer, aProposal.id, true)
  await expect(aRequest).resolves.toEqual({ granted: true })
})
it('prepared coordinator handles revalidate exact grants, declarations, cancellation and partial persistence', async () => {
  const f = await fixture(),
    controller = new AbortController()
  const prepared = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  expect(prepared.reused).toBe(false)
  prepared.current()
  await prepared.approve()
  prepared.current()
  prepared.cancel()
  const reused = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  expect(reused.reused).toBe(true)
  await f.approvals.revoke('installation', 'source', {
    workspaceId: 'workspace',
    root: f.root,
  })
  expect(() => reused.current()).toThrow(/changed/)
  reused.cancel()
  const pending = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.b,
    () => {},
    controller.signal,
  )
  const save = f.authority.saveSourceGrants.getMockImplementation()!
  f.authority.saveSourceGrants.mockImplementationOnce(async (...args) => {
    await save(...args)
    controller.abort()
  })
  await expect(pending.approve()).rejects.toThrow()
  expect(f.state()).toHaveLength(1) // Physical persistence may have landed; no rollback claim.
  expect(f.approvals.get(f.activation, 'source', f.b)).toBeUndefined()
  pending.cancel()
})
it('keeps retained grants at capacity without evicting A, and refuses changed declarations', async () => {
  const f = await fixture()
  f.authority.readSourceGrants.mockResolvedValue(
    Array.from({ length: SOURCE_LIMITS.grants }, (_, i) => ({
      installationId: 'installation',
      declaration: f.declaration,
      workspaceId: i ? 'old-' + i : 'workspace',
      root: i ? localPath('/old/' + i) : f.root,
    })),
  )
  await f.approvals.start()
  const before = f.approvals.get(f.activation, 'source', f.a)
  await expect(f.grant(f.b)).rejects.toThrow(/capacity/)
  expect(f.approvals.get(f.activation, 'source', f.a)).toBe(before)
  expect(f.authority.saveSourceGrants).not.toHaveBeenCalled()
  const changed = {
    ...f.activation,
    revision: {
      ...f.activation.revision,
      manifest: {
        ...f.activation.revision.manifest,
        access: [{ ...f.declaration, description: 'Different scope' }],
      },
    },
  }
  f.active.set('installation', changed)
  expect(f.approvals.get(changed, 'source', f.a)).toBeUndefined()
  expect(f.approvals.settings(changed)).toHaveLength(SOURCE_LIMITS.grants)
})

it('bounds coordinator reuse and rejects abort, revision replacement and root changes before either writer', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  await f.grant(f.a)
  const controller = new AbortController()
  const current = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs)
  expect(() => current.current()).toThrow(/ended/)
  current.cancel()
  const next = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  f.active.set('installation', { ...f.activation, generation: 'replacement' })
  expect(() => next.current()).toThrow(/ended/)
  next.cancel()
  f.active.set('installation', f.activation)
  const changed = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  f.workspaces[0] = { ...f.workspaces[0]!, root: localPath('/replacement') }
  expect(() => changed.current()).toThrow(/changed/)
  changed.cancel()
  f.workspaces[0] = { ...f.workspaces[0], root: f.root }
  const aborted = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    f.a,
    () => {},
    controller.signal,
  )
  controller.abort()
  expect(() => aborted.current()).toThrow()
  aborted.cancel()
})
it('holds physical decision admission until an exact revoked write settles', async () => {
  const f = await fixture()
  const prepared = await f.approvals.prepare(
    { installationId: 'installation', source: 'source', workspaceId: 'second' },
    () => {},
  )
  let release!: () => void, enter!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    reached = new Promise<void>((resolve) => {
      enter = resolve
    })
  const save = f.authority.saveSourceGrants.getMockImplementation()!
  f.authority.saveSourceGrants.mockImplementationOnce(async (...args) => {
    enter()
    await held
    return save(...args)
  })
  const writing = f.approvals.approve(prepared.token),
    rejected = expect(writing).rejects.toThrow(/revoked/)
  await reached
  const revocation = f.approvals.revoke('installation', 'source', {
    workspaceId: 'second',
    root: f.b.root!,
  })
  const tokens = []
  for (let i = 0; i < SOURCE_LIMITS.decisions - 1; i++)
    tokens.push(
      await f.approvals.prepare(
        { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
        () => {},
      ),
    )
  await expect(
    f.approvals.prepare(
      { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
      () => {},
    ),
  ).rejects.toThrow(/Too many/)
  release()
  await rejected
  await revocation
  expect(f.approvals.get(f.activation, 'source', f.b)).toBeUndefined()
  for (const token of tokens) f.approvals.cancelPrepared(token.token)
})

it('retains a moved registration as unavailable and never reuses its old root', async () => {
  const f = await fixture()
  await f.grant(f.a)
  const replacement = { ...f.workspaces[0]!, root: f.b.root! }
  f.workspaces[0] = replacement
  const context = { ...f.a, root: replacement.root }
  expect(f.approvals.get(f.activation, 'source', context)).toBeUndefined()
  expect(f.approvals.settings(f.activation)).toMatchObject([
    { granted: false, workspaceId: 'workspace', root: f.root },
  ])
  await f.grant(context)
  await f.approvals.revoke('installation', 'source', {
    workspaceId: 'workspace',
    root: f.root,
  })
  expect(f.approvals.get(f.activation, 'source', context)?.root).toEqual(replacement.root)
  expect(f.approvals.settings(f.activation)).toHaveLength(1)
})

it('rejects registration changes during preparation instead of changing the bound root', async () => {
  const f = await fixture()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.authority.assertWritable.mockReturnValueOnce(held)
  const rejected = expect(
    f.approvals.prepare(
      { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
      () => {},
    ),
  ).rejects.toThrow(/Registered workspace changed/)
  expect(f.authority.assertWritable).toHaveBeenCalledTimes(1)
  f.workspaces[0] = { ...f.workspaces[0]!, root: f.b.root! }
  release()
  await rejected
  expect(f.authority.saveSourceGrants).not.toHaveBeenCalled()
  expect(f.host.realpath.mock.calls.every(([path]) => path.path === f.root.path)).toBe(
    true,
  )
})

it('keeps application replacement singular across accepted declaration context revisions', async () => {
  const f = await fixture()
  await f.grant(f.a)
  await f.grant(f.b)
  const application = {
    ...f.activation,
    generation: 'application-revision',
    revision: {
      ...f.activation.revision,
      manifest: {
        ...f.activation.revision.manifest,
        access: [{ ...f.declaration, context: 'application' as const }],
      },
    },
  }
  f.active.set('installation', application)
  const prepared = await f.approvals.prepare(
    { installationId: 'installation', source: 'source', root: f.root },
    () => {},
  )
  await f.approvals.approve(prepared.token)
  expect(f.state()).toHaveLength(1)
  expect(f.approvals.settings(application)).toMatchObject([
    { granted: true, root: f.root },
  ])
  f.active.set('installation', f.activation)
  await f.grant(f.a)
  expect(f.state()).toHaveLength(1)
  expect(f.approvals.settings(f.activation)).toMatchObject([
    { granted: true, workspaceId: 'workspace', root: f.root },
  ])
})

it('prepares read-only source consent on the admitted SSH host without substituting local', async () => {
  const f = sourceFixture('workspace', undefined, asHostId('ssh'))
  stop.push(() => f.dispose())
  await f.approvals.start()
  const controller = new AbortController(),
    context = f.caller.context()!
  const prepared = await f.approvals.prepareWorkspaceRead(
    f.activation,
    'source',
    context,
    () => {},
    controller.signal,
  )
  expect(prepared.grant.root).toEqual(hostPath(asHostId('ssh'), '/library'))
  expect(f.host.realpath.mock.calls.every(([path]) => path.hostId === 'ssh')).toBe(true)
  await prepared.approve()
  prepared.current()
  prepared.cancel()
  expect(f.approvals.get(f.activation, 'source', context)?.root?.hostId).toBe('ssh')
  expect(
    f.approvals.get(f.activation, 'source', { ...context, root: localPath('/library') }),
  ).toBeUndefined()
})
