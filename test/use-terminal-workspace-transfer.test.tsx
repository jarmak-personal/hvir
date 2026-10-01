// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TerminalWorkspaceRuntimeOwner } from '../src/renderer/src/terminal/terminal-workspace-runtime-owner'
import { useTerminalWorkspaceTransfer } from '../src/renderer/src/terminal/use-terminal-workspace-transfer'

it('guards launch materialization and revokes a pending launch without allocating a session', async () => {
  const owner = new TerminalWorkspaceRuntimeOwner()
  const host = document.createElement('div')
  const root = createRoot(host)
  let allowed = false
  let transfer!: ReturnType<typeof useTerminalWorkspaceTransfer>
  const launchSession = vi.fn(() => 'terminal')
  function Harness(): null {
    transfer = useTerminalWorkspaceTransfer({
      owner,
      canMaterialize: () => allowed,
      acceptProjectState: vi.fn(),
      forgetWebViews: vi.fn(),
      onError: vi.fn(),
    })
    return null
  }
  try {
    act(() => root.render(<Harness />))
    await expect(transfer.prepare('target', true)).rejects.toThrow('no longer available')
    expect(owner.snapshot()).toEqual([])
    allowed = true
    const request = new AbortController()
    const pending = transfer.prepare('target', true, request.signal)
    expect(owner.snapshot()).toEqual(['target'])
    transfer.register('target', {
      hasSession: () => false,
      selectSession: () => false,
      transferOut: () => undefined,
      transferIn: () => undefined,
    })
    request.abort(new Error('Launch cancelled'))
    await expect(pending).rejects.toThrow('Launch cancelled')
    transfer.release('target')
    expect(owner.snapshot()).toEqual([])
    transfer.register('target', {
      launchSession,
      hasSession: () => false,
      selectSession: () => false,
      transferOut: () => undefined,
      transferIn: () => undefined,
    })
    expect(launchSession).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    owner.dispose()
  }
})
