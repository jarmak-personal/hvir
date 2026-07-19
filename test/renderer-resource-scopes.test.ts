import { describe, expect, it, vi } from 'vitest'

import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { localPath } from '../src/shared'

const firstRoot = localPath('/project/first')
const secondRoot = localPath('/project/second')

describe('RendererResourceScopes', () => {
  it('isolates owners and rolls generations before asynchronous cleanup', async () => {
    const scopes = new RendererResourceScopes()
    const first = scopes.activateOwner(10)
    const other = scopes.activateOwner(20)
    let finishCleanup: (() => void) | undefined
    const disposed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        }),
    )
    scopes.register(first, { lifetime: 'renderer', type: 'attention' }, disposed)
    const otherDisposed = vi.fn()
    scopes.register(other, { lifetime: 'renderer', type: 'attention' }, otherDisposed)

    const transition = scopes.rolloverOwner(first.id)

    expect(scopes.isCurrent(first)).toBe(false)
    expect(transition.owner.generation).toBe(first.generation + 1)
    expect(scopes.isCurrent(other)).toBe(true)
    expect(disposed).toHaveBeenCalledOnce()
    expect(otherDisposed).not.toHaveBeenCalled()
    finishCleanup?.()
    await transition.cleanup
  })

  it('rejects registrations and late completions from revoked generations', async () => {
    const scopes = new RendererResourceScopes()
    const stale = scopes.activateOwner(10)
    await scopes.rolloverOwner(10).cleanup

    expect(() =>
      scopes.register(
        stale,
        { lifetime: 'workspace', type: 'pty-session', root: firstRoot, id: 'late' },
        vi.fn(),
      ),
    ).toThrow('has been revoked')
  })

  it('bulk-revokes one workspace without flattening renderer resources', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(10)
    const first = vi.fn()
    const second = vi.fn()
    const attention = vi.fn()
    scopes.register(
      owner,
      { lifetime: 'workspace', type: 'web-pane', root: firstRoot, id: 'first' },
      first,
    )
    scopes.register(
      owner,
      { lifetime: 'workspace', type: 'web-pane', root: secondRoot, id: 'second' },
      second,
    )
    scopes.register(owner, { lifetime: 'renderer', type: 'attention' }, attention)

    await scopes.revokeWorkspace(firstRoot)

    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(attention).not.toHaveBeenCalled()
    await scopes.revokeOwner(owner.id)
    expect(second).toHaveBeenCalledOnce()
    expect(attention).toHaveBeenCalledOnce()
  })

  it('tears down in reverse registration order and stays idempotent', async () => {
    const calls: string[] = []
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(10)
    scopes.register(owner, { lifetime: 'renderer', type: 'attention' }, () => {
      calls.push('first')
    })
    const lease = scopes.register(
      owner,
      { lifetime: 'renderer', type: 'ssh-prompt-presentation' },
      () => {
        calls.push('second')
      },
    )

    await Promise.all([scopes.revokeOwner(owner.id), scopes.revokeOwner(owner.id)])
    await lease.dispose()

    expect(calls).toEqual(['second', 'first'])
  })

  it('rejects accidental duplicate registrations', () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(10)
    scopes.register(owner, { lifetime: 'renderer', type: 'attention' }, vi.fn())

    expect(() =>
      scopes.register(owner, { lifetime: 'renderer', type: 'attention' }, vi.fn()),
    ).toThrow('Renderer attention resource is already registered')
  })

  it('reuses an explicitly equivalent idempotent registration', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(10)
    const dispose = vi.fn()
    const duplicateDispose = vi.fn()
    const qualifier = {
      lifetime: 'workspace' as const,
      type: 'web-pane' as const,
      root: firstRoot,
      id: 'pane',
    }
    const first = scopes.register(owner, qualifier, dispose)
    const duplicate = scopes.register(owner, qualifier, duplicateDispose, {
      duplicate: 'reuse',
    })

    await duplicate.dispose()
    await first.dispose()

    expect(dispose).toHaveBeenCalledOnce()
    expect(duplicateDispose).not.toHaveBeenCalled()
  })

  it('uses collision-proof tuple keys for host paths and resource ids', async () => {
    const calls: string[] = []
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(10)
    scopes.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'web-pane',
        root: localPath('/project:a'),
        id: 'b',
      },
      () => {
        calls.push('first')
      },
    )
    scopes.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'web-pane',
        root: localPath('/project'),
        id: 'a:b',
      },
      () => {
        calls.push('second')
      },
    )

    await scopes.revokeOwner(owner.id)

    expect(calls).toEqual(['second', 'first'])
  })
})
