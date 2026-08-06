import { describe, expect, it, vi } from 'vitest'

import { createRendererPresentationInstaller } from '../src/main/renderer-presentation-resources'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'

describe('renderer presentation resources', () => {
  it('registers exact-generation attention, SSH, and diagnostic cleanup', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(12)
    const attention = { remove: vi.fn() }
    const sshPrompter = { revokeOwner: vi.fn() }
    const reports = { revoke: vi.fn() }
    const install = createRendererPresentationInstaller({
      scopes,
      attention: () => attention as never,
      sshPrompter: () => sshPrompter as never,
      reports: reports as never,
    })

    expect(install(owner)).toBe(owner)
    await scopes.revokeOwner(owner.id)

    expect(attention.remove).toHaveBeenCalledExactlyOnceWith(owner.id, owner.generation)
    expect(sshPrompter.revokeOwner).toHaveBeenCalledExactlyOnceWith(owner)
    expect(reports.revoke).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it('reads late-bound presentation owners at cleanup time', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(12)
    const attention = { remove: vi.fn() }
    let current: typeof attention | null = null
    const install = createRendererPresentationInstaller({
      scopes,
      attention: () => current as never,
      sshPrompter: () => null,
      reports: { revoke: vi.fn() } as never,
    })
    install(owner)
    current = attention

    await scopes.revokeOwner(owner.id)
    expect(attention.remove).toHaveBeenCalledExactlyOnceWith(owner.id, owner.generation)
  })
})
