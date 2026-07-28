import { describe, expect, it, vi } from 'vitest'

import { TerminalWorkspaceRuntimeOwner } from '../src/renderer/src/terminal/terminal-workspace-runtime-owner'
import type { TerminalWorkspaceController } from '../src/renderer/src/terminal/use-terminal-workspace-move'

describe('TerminalWorkspaceRuntimeOwner', () => {
  it('materializes only retained workspace models', () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const listener = vi.fn()
    owner.subscribe(listener)

    owner.retainWorkspace('workspace-a', true)
    owner.retainWorkspace('workspace-a', true)
    owner.retainWorkspace('workspace-b', true)

    expect(owner.snapshot()).toEqual(['workspace-a', 'workspace-b'])
    expect(listener).toHaveBeenCalledTimes(2)

    owner.retainWorkspace('workspace-a', false)
    expect(owner.snapshot()).toEqual(['workspace-b'])
    owner.dispose()
  })

  it('admits an unopened transfer target until its controller is ready', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const prepared = owner.prepareTransferTarget('workspace-target')
    let ready = false
    void prepared.then(() => {
      ready = true
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    expect(owner.snapshot()).toEqual(['workspace-target'])

    owner.registerController('workspace-target', controller())
    await prepared
    expect(ready).toBe(true)

    owner.retainWorkspace('workspace-target', true)
    owner.releaseTransferTarget('workspace-target')
    expect(owner.snapshot()).toEqual(['workspace-target'])
    owner.dispose()
  })

  it('rejects late transfer admission when a workspace is removed', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const prepared = owner.prepareTransferTarget('workspace-removed')

    owner.pruneWorkspaces(new Set())

    await expect(prepared).rejects.toThrow('no longer available')
    expect(owner.snapshot()).toEqual([])
    owner.dispose()
  })
})

function controller(): TerminalWorkspaceController {
  return {
    hasSession: vi.fn(() => false),
    transferOut: vi.fn(() => undefined),
    transferIn: vi.fn(),
  }
}
