import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSourceRequestOwner } from '../src/main/extensions/source-request'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { sourceFixture } from './fixtures/extension-source'
import { SOURCE_LIMITS } from '../src/shared/extensions/source-access'
import { hostPath, asHostId, localPath } from '../src/shared/host-path'

const dispose: (() => void)[] = []
afterEach(() => {
  for (const stop of dispose.splice(0)) stop()
  vi.useRealTimers()
})
async function fixture(context: 'application' | 'workspace' = 'application') {
  const f = sourceFixture(context),
    scopes = new RendererResourceScopes(),
    renderer = scopes.activateOwner(1)
  let foreground = true
  const publish = vi.fn(),
    owner = new ExtensionSourceRequestOwner(
      scopes,
      f.approvals,
      () => foreground,
      publish,
    )
  const revoked = f.revoked.getMockImplementation()!
  f.revoked.mockImplementation((installation, source, binding, cancelRequests) => {
    revoked(installation, source, binding, cancelRequests)
    if (cancelRequests) owner.revoke(installation, source, binding)
    owner.revalidate()
  })
  dispose.push(() => {
    owner.dispose()
    f.dispose()
  })
  await f.approvals.start()
  return {
    ...f,
    owner,
    renderer,
    scopes,
    publish,
    foreground: (value: boolean) => {
      foreground = value
      owner.revalidate()
    },
    request: () =>
      owner.request(
        {
          ...f.caller,
          current: () => {
            f.caller.current()
            if (f.active.get('installation') !== f.activation)
              throw new Error('Activation revoked')
          },
        },
        { source: 'source', root: f.root },
        renderer,
      ),
  }
}
function barrier() {
  let resume!: () => void, enter!: () => void
  const waiting = new Promise<void>((resolve) => {
      resume = resolve
    }),
    entered = new Promise<void>((resolve) => {
      enter = resolve
    })
  return { resume, enter, waiting, entered }
}
async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.owner.snapshot(f.renderer)[0]?.state).toBe('ready'))
  const p = f.owner.snapshot(f.renderer)[0]!
  if (p.state !== 'ready') throw new Error('Canonical proposal not ready')
  return p
}
describe('in-context canonical human read decision', () => {
  it('reuses a current manual ancestor grant without replacing its scope', async () => {
    const f = await fixture(),
      manual = localPath('/')
    const stat = f.host.stat.getMockImplementation()!
    f.host.stat.mockImplementation((value) =>
      value.path === manual.path
        ? Promise.resolve({ type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 })
        : stat(value),
    )
    const prepared = await f.approvals.prepare(
      { installationId: 'installation', source: 'source', root: manual },
      () => {},
    )
    await f.approvals.approve(prepared.token)
    const saved = f.state(),
      writes = f.authority.saveSourceGrants.mock.calls.length
    await expect(f.request()).resolves.toEqual({ granted: true })
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.approvals.get(f.activation, 'source')?.root).toEqual(manual)
    expect(f.state()).toEqual(saved)
    expect(f.authority.saveSourceGrants).toHaveBeenCalledTimes(writes)
    await expect(
      f.reading.select(f.caller, { source: 'source', path: f.path }),
    ).resolves.toMatchObject({ path: f.path })
  })
  it('reuses permission without probing but still refuses covered missing or escaping files', async () => {
    const f = await fixture()
    await f.grant()
    f.host.realpath.mockClear()
    f.host.stat.mockClear()
    f.host.realpath.mockImplementation((path) =>
      path.path === f.path.path
        ? Promise.reject(new Error('ENOENT private missing file'))
        : Promise.resolve(path),
    )
    await expect(f.request()).resolves.toEqual({ granted: true })
    expect(f.host.realpath).not.toHaveBeenCalled()
    await expect(
      f.reading.select(f.caller, { source: 'source', path: f.path }),
    ).rejects.toThrow(/ENOENT/)
    f.host.realpath.mockImplementation((path) =>
      Promise.resolve(path.path === f.path.path ? localPath('/private/escape.md') : path),
    )
    await expect(
      f.reading.select(f.caller, { source: 'source', path: f.path }),
    ).rejects.toThrow()
    expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
  })
  it.each(['missing', 'file', 'unreadable', 'valid'] as const)(
    'keeps %s preparation private until the same human decision',
    async (kind) => {
      const f = await fixture(),
        b = barrier()
      const original = f.host.realpath.getMockImplementation()!
      f.host.realpath.mockImplementationOnce(async (...args) => {
        b.enter()
        await b.waiting
        if (kind === 'missing') throw new Error('ENOENT private missing folder')
        if (kind === 'unreadable') throw new Error('EACCES private folder')
        return original(...args)
      })
      if (kind === 'file')
        f.host.stat.mockResolvedValue({ type: 'file', size: 10, mode: 0o644, mtimeMs: 0 })
      const settled = vi.fn(),
        request = f.request().then(settled)
      await b.entered
      const preparing = f.owner.snapshot(f.renderer)[0]!
      expect(preparing).toMatchObject({ state: 'preparing', reportedRoot: f.root })
      expect(preparing).not.toHaveProperty('root')
      expect(() => f.owner.decide(f.renderer, preparing.id, true)).toThrow(/canonical/)
      b.resume()
      await vi.waitFor(() =>
        expect(f.owner.snapshot(f.renderer)[0]?.state).toBe(
          kind === 'valid' ? 'ready' : 'failed',
        ),
      )
      expect(settled).not.toHaveBeenCalled()
      f.owner.decide(f.renderer, preparing.id, false)
      await request
      expect(settled).toHaveBeenCalledWith({ granted: false })
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      expect(f.state()).toEqual([])
    },
  )
  it('retires a human decline immediately but owns late physical preparation and token cleanup', async () => {
    const f = await fixture(),
      b = barrier(),
      original = f.host.realpath.getMockImplementation()!
    f.host.realpath.mockImplementationOnce(async (...args) => {
      b.enter()
      await b.waiting
      return original(...args)
    })
    const settled = vi.fn(),
      request = f.request().then(settled)
    await b.entered
    const p = f.owner.snapshot(f.renderer)[0]!
    f.owner.decide(f.renderer, p.id, false)
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(settled).not.toHaveBeenCalled()
    b.resume()
    await request
    expect(settled).toHaveBeenCalledWith({ granted: false })
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(f.state()).toEqual([])
    // All canonical slots are available: no orphan token remains after late completion.
    const tokens = await Promise.all(
      Array.from({ length: SOURCE_LIMITS.decisions }, () =>
        f.approvals.prepare(
          { installationId: 'installation', source: 'source', root: f.root },
          () => {},
        ),
      ),
    )
    for (const prepared of tokens) f.approvals.cancelPrepared(prepared.token)
  })
  it.each(['ready', 'failed'] as const)(
    'retains %s admission and physical canceled preparation',
    async (state) => {
      const f = await fixture(),
        b = barrier()
      f.host.realpath.mockImplementation(async () => {
        b.enter()
        await b.waiting
        throw new Error('ENOENT private folder')
      })
      const requests = Array.from({ length: SOURCE_LIMITS.decisions }, () => f.request())
      const rejected = requests.map((request) => expect(request).rejects.toThrow())
      await b.entered
      expect(f.owner.snapshot(f.renderer)).toHaveLength(SOURCE_LIMITS.decisions)
      f.controller.abort()
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      const caller = { ...f.caller, signal: new AbortController().signal }
      await expect(
        f.owner.request(caller, { source: 'source', root: f.root }, f.renderer),
      ).rejects.toThrow(/Too many/)
      b.resume()
      await Promise.all(rejected)
      if (state === 'ready')
        f.host.realpath.mockImplementation((path) => Promise.resolve(path))
      const failed = Array.from({ length: SOURCE_LIMITS.decisions }, () =>
        f.owner.request(caller, { source: 'source', root: f.root }, f.renderer),
      )
      await vi.waitFor(() =>
        expect(
          f.owner.snapshot(f.renderer).filter((p) => p.state === state),
        ).toHaveLength(SOURCE_LIMITS.decisions),
      )
      expect(f.owner.snapshot(f.renderer)).toHaveLength(SOURCE_LIMITS.decisions)
      await expect(
        f.owner.request(caller, { source: 'source', root: f.root }, f.renderer),
      ).rejects.toThrow(/Too many/)
      for (const p of f.owner.snapshot(f.renderer))
        f.owner.decide(f.renderer, p.id, false)
      await expect(Promise.all(failed)).resolves.toEqual(
        Array.from({ length: SOURCE_LIMITS.decisions }, () => ({ granted: false })),
      )
    },
  )
  it('retires failed preparation on canonical revocation even without a token', async () => {
    const f = await fixture()
    f.host.realpath.mockRejectedValue(new Error('ENOENT private folder'))
    const request = f.request(),
      rejected = expect(request).rejects.toThrow(/revoked|ended/)
    await vi.waitFor(() => expect(f.owner.snapshot(f.renderer)[0]?.state).toBe('failed'))
    await f.approvals.revoke('installation', 'source')
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    await rejected
  })
  it('does not reuse an unrelated sibling saved scope', async () => {
    const f = await fixture()
    f.authority.readSourceGrants.mockResolvedValueOnce([
      {
        installationId: 'installation',
        declaration: f.declaration,
        root: localPath('/library-other'),
      },
    ])
    await f.approvals.start()
    const request = f.request(),
      p = await proposal(f)
    expect(p.root).toEqual(f.root)
    f.owner.decide(f.renderer, p.id, false)
    await expect(request).resolves.toEqual({ granted: false })
    expect(f.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
  it('refuses persisted application scope on another host through the canonical owner', async () => {
    const f = await fixture()
    f.authority.readSourceGrants.mockResolvedValueOnce([
      {
        installationId: 'installation',
        declaration: f.declaration,
        root: hostPath(asHostId('ssh:test'), '/library'),
      },
    ])
    await f.approvals.start()
    const request = f.request()
    await expect(request).rejects.toThrow(/Saved read grants/)
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(f.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
  it('publishes the canonical root and persists only a distinct trusted decision', async () => {
    const f = await fixture(),
      request = f.request(),
      p = await proposal(f)
    expect(p.root).toEqual(f.root)
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    f.owner.decide(f.renderer, p.id, true)
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(() => f.owner.decide(f.renderer, p.id, true)).toThrow(/no longer current/)
    await expect(request).resolves.toEqual({ granted: true })
    expect(f.approvals.get(f.activation, 'source')?.root).toEqual(f.root)
    await expect(f.request()).resolves.toEqual({ granted: true })
    expect(f.owner.snapshot(f.renderer)).toEqual([])
  })
  it('declines without persisting or exposing another renderer decision', async () => {
    const f = await fixture(),
      request = f.request(),
      p = await proposal(f)
    const other = f.scopes.activateOwner(2)
    expect(f.owner.snapshot(other)).toEqual([])
    expect(() => f.owner.decide(other, p.id, true)).toThrow(/no longer current/)
    f.owner.decide(f.renderer, p.id, false)
    await expect(request).resolves.toEqual({ granted: false })
    expect(f.state()).toEqual([])
    await expect(f.approvals.approve(p.id)).rejects.toThrow()
  })
  it('retires the UI immediately while an accepted physical write remains owned', async () => {
    const f = await fixture(),
      b = barrier(),
      original = f.authority.saveSourceGrants.getMockImplementation()!
    f.authority.saveSourceGrants.mockImplementationOnce(async (...args) => {
      b.enter()
      await b.waiting
      return original(...args)
    })
    const request = f.request(),
      p = await proposal(f)
    f.owner.decide(f.renderer, p.id, true)
    await b.entered
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    const rejection = expect(request).rejects.toThrow()
    f.foreground(false)
    f.foreground(true)
    b.resume()
    await rejection
    expect(f.state()).toEqual([])
  })
  it('does not claim rollback if cancellation follows successful persistence', async () => {
    const f = await fixture(),
      original = f.authority.saveSourceGrants.getMockImplementation()!
    f.authority.saveSourceGrants.mockImplementationOnce(async (...args) => {
      await original(...args)
      f.controller.abort(new Error('Read canceled'))
    })
    const request = f.request(),
      rejection = expect(request).rejects.toThrow(/canceled|ended/),
      p = await proposal(f)
    f.owner.decide(f.renderer, p.id, true)
    await rejection
    expect(f.state()).not.toEqual([])
    expect(f.owner.snapshot(f.renderer)).toEqual([])
  })
  it('retains preparation admission and rejects a hidden-then-returned intent without late publication', async () => {
    const f = await fixture(),
      b = barrier(),
      original = f.host.realpath.getMockImplementation()!
    f.host.realpath.mockImplementationOnce(async (...args) => {
      b.enter()
      await b.waiting
      return original(...args)
    })
    let settled = false
    const request = f.request().finally(() => {
        settled = true
      }),
      rejection = expect(request).rejects.toThrow()
    await b.entered
    f.foreground(false)
    f.foreground(true)
    expect(settled).toBe(false)
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    b.resume()
    await rejection
    expect(f.state()).toEqual([])
  })
  it.each(['cancel', 'close', 'renderer', 'activation', 'dispose'] as const)(
    'retires pending consent on %s',
    async (boundary) => {
      const f = await fixture(),
        request = f.request(),
        rejection = expect(request).rejects.toThrow(),
        p = await proposal(f)
      if (boundary === 'cancel') f.controller.abort()
      if (boundary === 'close') f.close()
      if (boundary === 'renderer') f.scopes.rolloverOwner(1)
      if (boundary === 'activation') f.active.delete('installation')
      if (boundary === 'dispose') f.owner.dispose()
      f.owner.revalidate()
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      await rejection
      expect(f.state()).toEqual([])
      await expect(f.approvals.approve(p.id)).rejects.toThrow()
    },
  )
  it('retires explicit canonical revocation immediately without canceling ordinary acceptance', async () => {
    const f = await fixture(),
      original = f.reading.revoke.bind(f.reading)
    vi.spyOn(f.reading, 'revoke').mockImplementation((...args) => {
      original(...args)
      f.owner.revalidate()
    })
    const request = f.request(),
      rejection = expect(request).rejects.toThrow(/revoked|ended/),
      p = await proposal(f)
    const revoked = f.approvals.revoke('installation', 'source')
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(() => f.owner.decide(f.renderer, p.id, true)).toThrow(/no longer current/)
    await revoked
    await rejection
    const next = f.request(),
      nextProposal = await proposal(f)
    f.owner.decide(f.renderer, nextProposal.id, true)
    await expect(next).resolves.toEqual({ granted: true })
    expect(f.approvals.get(f.activation, 'source')?.root).toEqual(f.root)
  })
  it.each(['installation', 'source'] as const)(
    'keeps a contextual request live when another %s is revoked',
    async (scope) => {
      const f = await fixture(),
        request = f.request()
      void request.catch(() => {})
      const p = await proposal(f)
      await f.approvals.revoke(
        scope === 'installation' ? 'another-installation' : 'installation',
        scope === 'source' ? 'another-source' : undefined,
      )
      f.owner.revalidate()
      expect(f.owner.snapshot(f.renderer)).toEqual([p])
      f.owner.decide(f.renderer, p.id, true)
      await expect(request).resolves.toEqual({ granted: true })
      expect(f.approvals.get(f.activation, 'source')?.root).toEqual(f.root)
    },
  )
  it('contains abort-time publication failure in the owning request and frees admission', async () => {
    const f = await fixture(),
      request = f.request(),
      rejected = expect(request).rejects.toThrow(/Publication failed/)
    await proposal(f)
    f.publish.mockImplementationOnce(() => {
      throw new Error('Publication failed')
    })
    f.controller.abort()
    await rejected
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(f.state()).toEqual([])
  })
  it.each(['initial', 'decision'] as const)(
    'cleans tokens and admission after %s publication fails',
    async (edge) => {
      const f = await fixture()
      if (edge === 'initial')
        f.publish.mockImplementationOnce(() => {
          throw new Error('Publication failed')
        })
      const request = f.request(),
        rejected = expect(request).rejects.toThrow(/Publication failed/)
      if (edge === 'decision') {
        const p = await proposal(f)
        f.publish.mockImplementationOnce(() => {
          throw new Error('Publication failed')
        })
        expect(() => f.owner.decide(f.renderer, p.id, true)).toThrow('Publication failed')
      }
      await rejected
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      expect(f.state()).toEqual([])
      const next = f.request(),
        p = await proposal(f)
      f.owner.decide(f.renderer, p.id, false)
      await expect(next).resolves.toEqual({ granted: false })
    },
  )
  it.each(['ready', 'failed'] as const)(
    'expires a finite %s decision without a grant',
    async (state) => {
      vi.useFakeTimers()
      const f = await fixture()
      if (state === 'failed')
        f.host.realpath.mockRejectedValue(new Error('ENOENT private folder'))
      const request = f.request(),
        rejection = expect(request).rejects.toThrow(/expired/)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.owner.snapshot(f.renderer)[0]?.state).toBe(state)
      await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs)
      await rejection
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      expect(f.state()).toEqual([])
    },
  )
  it('does not admit guest-chosen workspace roots, agent, or caller-supplied authority requests', async () => {
    const f = await fixture('workspace')
    await expect(f.request()).rejects.toThrow(/main-admitted/)
    await expect(
      f.owner.request(
        { ...f.caller, allowed: false },
        { source: 'source', root: f.root },
        f.renderer,
      ),
    ).rejects.toThrow(/human-selected/)
    await expect(
      f.owner.request(
        f.caller,
        { source: 'source', root: f.root, caller: 'human' },
        f.renderer,
      ),
    ).rejects.toThrow(/only/)
    expect(f.host.realpath).not.toHaveBeenCalled()
  })
})
