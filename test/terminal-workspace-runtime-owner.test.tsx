// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalWorkspaceRuntimeOwner } from '../src/renderer/src/terminal/terminal-workspace-runtime-owner'
import type { TerminalWorkspaceController } from '../src/renderer/src/terminal/use-terminal-workspace-move'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsTerminalHandle,
  asSessionsWorkspaceRuntimeId,
  asSessionsPtyHandle,
  sessionsWorkspaceQualifier,
  type SessionsTerminalHandle,
  type SessionsWorkspaceQualifier,
} from '../src/shared'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

describe('TerminalWorkspaceRuntimeOwner', () => {
  beforeEach(() => {
    ghosttyState.instances.splice(0)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
  })
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
    let sessions = [
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
    ]
    const source = vi.fn(() => sessions)
    owner.registerSessionsSource('workspace-a', source)
    owner.sessionsChanged('workspace-a')
    expect(source).not.toHaveBeenCalled()

    const listener = vi.fn(() => owner.sessionsObservation.snapshot())
    const release = owner.sessionsObservation.subscribe(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(source).toHaveBeenCalledOnce()
    const eligibleRevision = owner.sessionsSurface.availabilityRevision()
    owner.sessionsChanged('workspace-a')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(source).toHaveBeenCalledTimes(2)
    expect(owner.sessionsSurface.availabilityRevision()).toBe(eligibleRevision)

    sessions = [{ ...sessions[0]!, exited: true }]
    owner.sessionsChanged('workspace-a')
    expect(owner.sessionsSurface.availabilityRevision()).toBeGreaterThan(
      eligibleRevision,
    )

    release()
    owner.sessionsChanged('workspace-a')
    expect(listener).toHaveBeenCalledTimes(3)
    owner.dispose()
    expect(owner.sessionsObservation.snapshot()).toEqual([])
  })

  it('selects and focuses only the exact projected live PTY after presentation commits', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    const selected = vi.fn(() => true)
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
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

  it('resolves a Sessions surface through its exact current renderer workspace owner across qualifier rotation', () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
    const release = owner.sessionsObservation.subscribe(() => undefined)
    const expected = { outcome: 'acquired' as const, lease: { release: vi.fn() } }
    const acquire = vi
      .spyOn(owner.runtimes, 'acquireSessionsSurface')
      .mockReturnValue(expected as never)
    const request = {
      handle,
      workspaceQualifier: qualifier,
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-a'),
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 8,
        rendererGeneration: 3,
      },
      demandGeneration: 4,
      projectionRevision: 5,
      sourceRevision: 9,
    }

    expect(owner.sessionsSurface.acquire(request)).toBe(expected)
    expect(acquire).toHaveBeenCalledExactlyOnceWith(request)
    expect(
      owner.sessionsSurface.acquire({
        ...request,
        workspaceQualifier: sessionsWorkspaceQualifier(2, 0, 0),
      }),
    ).toBe(expected)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(
      owner.sessionsSurface.acquire({
        ...request,
        workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-b'),
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'source-missing' })
    expect(acquire).toHaveBeenCalledTimes(2)
    release()
    owner.dispose()
    expect(owner.sessionsSurface.acquire(request)).toEqual({
      outcome: 'unavailable',
      reason: 'runtime-not-ready',
    })
  })

  it('distinguishes a missing renderer source from a source whose runtime is not ready', () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    const request = {
      handle,
      workspaceQualifier: qualifier,
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 8,
        rendererGeneration: 3,
      },
    }

    expect(owner.sessionsSurface.availability(request)).toEqual({
      outcome: 'unavailable',
      reason: 'source-missing',
    })
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
    const release = owner.sessionsObservation.subscribe(() => undefined)
    expect(owner.sessionsSurface.availability(request)).toEqual({
      outcome: 'unavailable',
      reason: 'runtime-not-ready',
    })
    release()
    owner.dispose()
  })

  it('updates preflight and acquisition from one source event before another snapshot read', () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    let sessions = [session(handle, qualifier)]
    owner.registerSessionsSource('workspace-a', () => sessions)
    const release = owner.sessionsObservation.subscribe(() => undefined)
    const availabilityChanged = vi.fn()
    const releaseAvailability = owner.sessionsSurface.subscribeAvailability(
      availabilityChanged,
    )
    const available = vi
      .spyOn(owner.runtimes, 'sessionsSurfaceAvailability')
      .mockReturnValue({ outcome: 'available' })
    const expected = { outcome: 'acquired' as const, lease: { release: vi.fn() } }
    const acquire = vi
      .spyOn(owner.runtimes, 'acquireSessionsSurface')
      .mockReturnValue(expected as never)
    const capability = {
      handle,
      workspaceQualifier: qualifier,
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 8,
        rendererGeneration: 3,
      },
    }
    const request = {
      ...capability,
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-a'),
      demandGeneration: 4,
      projectionRevision: 5,
      sourceRevision: 9,
    }

    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'available',
    })
    expect(owner.sessionsSurface.acquire(request)).toBe(expected)

    sessions = [{ ...session(handle, qualifier), dormant: true }]
    owner.sessionsChanged('workspace-a')

    expect(availabilityChanged).toHaveBeenCalledOnce()
    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'unavailable',
      reason: 'source-missing',
    })
    expect(owner.sessionsSurface.acquire(request)).toEqual({
      outcome: 'unavailable',
      reason: 'source-missing',
    })
    expect(available).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()
    expect(owner.sessionsObservation.snapshot()).toEqual(sessions)
    releaseAvailability()
    release()
    owner.dispose()
  })

  it('preflights and acquires the actual live surface through its indexed workspace source', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() =>
          Promise.resolve({
            outcome: 'started' as const,
            id: 'terminal-1',
            instanceId: 'instance-1',
            pid: 4321,
            resumed: false,
            reattached: false,
            harnessSessionId: undefined,
            identityStatus: 'unsupported' as const,
            capabilities: {
              sessionIdentity: 'none' as const,
              exactResume: false,
              contextPresentation: 'none' as const,
            },
          }),
        ),
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const owner = new TerminalWorkspaceRuntimeOwner()
    const runtime = owner.runtimes.acquire(ghosttyLifecycleRuntimeOptions())
    const handle = asSessionsTerminalHandle('terminal-1')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
    const release = owner.sessionsObservation.subscribe(() => undefined)
    const capability = {
      handle,
      workspaceQualifier: qualifier,
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 8,
        rendererGeneration: 3,
      },
    }
    const workspace = document.createElement('div')
    const detail = document.createElement('div')
    document.body.append(workspace, detail)
    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'unavailable',
      reason: 'runtime-not-ready',
    })
    const revisionBeforeRuntimeStart = owner.sessionsSurface.availabilityRevision()
    runtime.attach(workspace)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(owner.sessionsSurface.availabilityRevision()).toBeGreaterThan(
      revisionBeforeRuntimeStart,
    )
    const availabilityChanged = vi.fn()
    const releaseAvailability =
      owner.sessionsSurface.subscribeAvailability(availabilityChanged)
    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'available',
    })
    expect(
      owner.sessionsSurface.availability({
        ...capability,
        livePty: { ...capability.livePty, handle: asSessionsPtyHandle('replaced') },
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'instance-mismatch' })

    const acquisition = owner.sessionsSurface.acquire({
      ...capability,
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-a'),
      demandGeneration: 1,
      projectionRevision: 2,
      sourceRevision: 3,
    })
    expect(acquisition.outcome).toBe('acquired')
    if (acquisition.outcome !== 'acquired') throw new Error('Expected surface lease')
    expect(availabilityChanged).toHaveBeenCalledOnce()
    const engine = workspace.querySelector('.terminal-engine-host')
    expect(acquisition.lease.attach(detail)).toBe(true)
    expect(detail.querySelector('.terminal-engine-host')).toBe(engine)
    expect(ghosttyState.instances).toHaveLength(1)
    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'unavailable',
      reason: 'lease-conflict',
    })
    acquisition.lease.release()
    expect(availabilityChanged).toHaveBeenCalledTimes(2)
    expect(owner.sessionsSurface.availability(capability)).toEqual({
      outcome: 'available',
    })
    expect(workspace.querySelector('.terminal-engine-host')).toBe(engine)
    releaseAvailability()
    release()
    owner.dispose()
  })

  it('waits a bounded number of frames for delayed presentation and revokes the wait on disposal', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-delayed')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
    owner.registerController('workspace-a', {
      ...controller(),
      hasSession: vi.fn(() => true),
      selectSession: vi.fn(() => true),
    })
    const focusLive = vi
      .spyOn(owner.runtimes, 'focusLiveInstance')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const frame = nextFrame++
      frames.set(frame, callback)
      return frame
    })
    const cancel = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((frame) => {
        frames.delete(frame)
      })

    const focused = owner.focusProjectedSession(handle, qualifier, {
      handle: asSessionsPtyHandle('instance-delayed'),
      rendererOwnerId: 8,
      rendererGeneration: 3,
    })
    frames.get(1)?.(0)
    expect(focusLive).toHaveBeenCalledOnce()
    expect(frames.has(2)).toBe(true)
    frames.get(2)?.(16)
    await expect(focused).resolves.toBe(true)

    vi.mocked(focusLive).mockReset().mockReturnValue(false)
    const revoked = owner.focusProjectedSession(handle, qualifier, {
      handle: asSessionsPtyHandle('instance-delayed'),
      rendererOwnerId: 8,
      rendererGeneration: 3,
    })
    expect(frames.has(3)).toBe(true)
    owner.dispose()
    await expect(revoked).resolves.toBe(false)
    expect(cancel).toHaveBeenCalledWith(3)
    expect(focusLive).not.toHaveBeenCalled()
  })

  it('stops a projected focus readiness wait after its bounded frame budget', async () => {
    const owner = new TerminalWorkspaceRuntimeOwner()
    const handle = asSessionsTerminalHandle('terminal-never-presented')
    const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
    owner.registerSessionsSource('workspace-a', () => [session(handle, qualifier)])
    owner.registerController('workspace-a', {
      ...controller(),
      hasSession: vi.fn(() => true),
      selectSession: vi.fn(() => true),
    })
    const focusLive = vi.spyOn(owner.runtimes, 'focusLiveInstance').mockReturnValue(false)
    let nextFrame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame = callback
      return focusLive.mock.calls.length + 1
    })

    const focused = owner.focusProjectedSession(handle, qualifier, {
      handle: asSessionsPtyHandle('instance-never-presented'),
      rendererOwnerId: 8,
      rendererGeneration: 3,
    })
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const frame = nextFrame
      nextFrame = undefined
      frame?.(attempt * 16)
    }

    await expect(focused).resolves.toBe(false)
    expect(focusLive).toHaveBeenCalledTimes(12)
    expect(nextFrame).toBeUndefined()
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

function session(
  handle: SessionsTerminalHandle,
  workspaceQualifier: SessionsWorkspaceQualifier,
) {
  return {
    handle,
    workspaceQualifier,
    providerId: asHarnessProviderId('plain-shell'),
    profileId: asHarnessProfileId('plain-shell-default'),
    title: 'Shell',
    dormant: false,
    resumeOnStart: false,
    exited: false,
    recoveryUnavailable: false,
  }
}
