import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSourceRequestOwner } from '../src/main/extensions/source-request'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { sourceFixture } from './fixtures/extension-source'
import { SOURCE_LIMITS } from '../src/shared/extensions/source-access'

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
  await vi.waitFor(() => expect(f.owner.snapshot(f.renderer)).toHaveLength(1))
  return f.owner.snapshot(f.renderer)[0]!
}
describe('in-context canonical human read decision', () => {
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
  it('retains preparation admission and rejects a hidden-then-returned intent before publication', async () => {
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
  it('uses the canonical owner intent when a retained token is invalidated indirectly', async () => {
    const f = await fixture(),
      request = f.request(),
      rejected = expect(request).rejects.toThrow(/revoked|ended/),
      p = await proposal(f)
    f.approvals.discardPrepared('another-installation')
    f.owner.revalidate()
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(() => f.owner.decide(f.renderer, p.id, true)).toThrow(/no longer current/)
    await rejected
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
  it('expires a finite decision without a grant', async () => {
    vi.useFakeTimers()
    const f = await fixture(),
      request = f.request(),
      rejection = expect(request).rejects.toThrow(/expired/)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.owner.snapshot(f.renderer)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs)
    await rejection
    expect(f.owner.snapshot(f.renderer)).toEqual([])
    expect(f.state()).toEqual([])
  })
  it('does not admit workspace, agent, or caller-supplied authority requests', async () => {
    const f = await fixture('workspace')
    await expect(f.request()).rejects.toThrow(/application-local/)
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
