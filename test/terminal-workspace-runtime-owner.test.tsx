// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalWorkspaceRuntimeOwner } from '../src/renderer/src/terminal/terminal-workspace-runtime-owner'
import type { TerminalWorkspaceController } from '../src/renderer/src/terminal/use-terminal-workspace-move'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsTerminalHandle,
  asSessionsPtyHandle,
  sessionsWorkspaceQualifier,
} from '../src/shared'

describe('TerminalWorkspaceRuntimeOwner', () => {
  afterEach(() => vi.restoreAllMocks())
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

  it('reads materialized session facts only while an observer declares demand', () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const source = vi.fn(() => [
      {
        handle: asSessionsTerminalHandle('terminal-1'),
        workspaceQualifier: sessionsWorkspaceQualifier(1, 0, 0),
        providerId: asHarnessProviderId('plain-shell'),
        profileId: asHarnessProfileId('plain-shell-default'),
        title: 'Shell',
        dormant: false,
        resumeOnStart: false,
        exited: false,
        recoveryUnavailable: false,
      },
    ])
    owner.registerSessionsSource('workspace-a', source)
    owner.sessionsChanged('workspace-a')
    expect(source).not.toHaveBeenCalled()

    const listener = vi.fn(() => owner.sessionsObservation.snapshot())
    const release = owner.sessionsObservation.subscribe(listener)
    owner.sessionsChanged('workspace-a')
    expect(listener).toHaveBeenCalledOnce()
    expect(source).toHaveBeenCalledOnce()

    release()
    owner.sessionsChanged('workspace-a')
    expect(listener).toHaveBeenCalledOnce()
    owner.dispose()
    expect(owner.sessionsObservation.snapshot()).toEqual([])
  })

  it('selects and focuses only the exact projected live PTY after presentation commits', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    const selected = vi.fn(() => true)
    owner.registerSessionsSource('workspace-a', () => [
      {
        handle,
        workspaceQualifier: qualifier,
        providerId: asHarnessProviderId('plain-shell'),
        profileId: asHarnessProfileId('plain-shell-default'),
        title: 'Shell',
        dormant: false,
        resumeOnStart: false,
        exited: false,
        recoveryUnavailable: false,
      },
    ])
    owner.registerController('workspace-a', {
      ...controller(),
      hasSession: vi.fn(() => true),
      selectSession: selected,
    })
    const focusLive = vi.spyOn(owner.runtimes, 'focusLiveInstance').mockReturnValue(true)
    let runFrame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      runFrame = callback
      return 14
    })

    const focused = owner.focusProjectedSession(handle, qualifier, {
      handle: asSessionsPtyHandle('instance-1'),
      rendererOwnerId: 8,
      rendererGeneration: 3,
    })
    expect(selected).toHaveBeenCalledExactlyOnceWith(handle)
    expect(focusLive).not.toHaveBeenCalled()
    runFrame?.(0)

    await expect(focused).resolves.toBe(true)
    expect(focusLive).toHaveBeenCalledExactlyOnceWith(handle, 'instance-1')
    owner.dispose()
  })
})

function controller(): TerminalWorkspaceController {
  return {
    hasSession: vi.fn(() => false),
    selectSession: vi.fn(() => false),
    transferOut: vi.fn(() => undefined),
    transferIn: vi.fn(),
  }
}
