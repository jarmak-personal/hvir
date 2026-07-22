import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PtyExit } from '../src/main/project-host'
import { stopPtyAndWaitForExit, waitForPtyOutput } from '../src/main/smoke/pty-lifecycle'
import type { ManagedPty, PtySupervisor } from '../src/main/pty/pty-supervisor'
import { asHarnessProviderId, asHostId, localPath } from '../src/shared'

type ExitCallback = Parameters<PtySupervisor['onExit']>[0]
type LifecycleSupervisor = Pick<PtySupervisor, 'get' | 'kill' | 'onExit'>
type OutputSupervisor = Pick<PtySupervisor, 'attach' | 'get'>

describe('smoke PTY output', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('matches semantic output across chunks and releases its production attachment', async () => {
    const fixture = outputFixture()
    const pending = waitForPtyOutput({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      expected: 'hvir-profile-smoke:structured',
      scenario: 'custom profile PTY output',
      trigger: () => fixture.order.push('trigger'),
    })

    expect(fixture.order).toEqual(['attach', 'trigger'])
    fixture.emitData('hvir-profile-')
    fixture.emitData('smoke:structured')

    await expect(pending).resolves.toBe('hvir-profile-smoke:structured')
    expect(fixture.order).toEqual(['attach', 'trigger', 'data', 'data', 'detach'])
    const handlers = fixture.attach.mock.calls[0]?.[2]
    expect(fixture.attach).toHaveBeenCalledWith(
      fixture.terminal.id,
      fixture.terminal.ownerId,
      handlers,
      fixture.terminal.ownerGeneration,
    )
    expect(typeof handlers?.onData).toBe('function')
  })

  it('bounds retained output while reporting the last observed production state', async () => {
    vi.useFakeTimers()
    const fixture = outputFixture()
    fixture.get.mockReturnValue(fixture.terminal)
    const pending = waitForPtyOutput({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      expected: 'missing-output',
      scenario: 'custom profile PTY output',
      trigger: () => fixture.order.push('trigger'),
      timeoutMs: 20,
    }).catch((reason: unknown) => reason)
    fixture.emitData(`discarded-prefix${'x'.repeat(5_000)}`)

    await vi.advanceTimersByTimeAsync(20)
    const reason = await pending

    expect(reason).toBeInstanceOf(Error)
    const message = (reason as Error).message
    expect(message).toContain(
      'custom profile PTY output timed out ' +
        '(terminalId=profile-smoke-terminal, pid=9102, elapsedMs=20, ' +
        'outputCallbackFired=true, supervisorMember=true, retainedOutput="',
    )
    expect(message).not.toContain('discarded-prefix')
    expect(message.length).toBeLessThan(4_500)
    expect(fixture.disposeOutput).toHaveBeenCalledOnce()
  })

  it('reports an early production exit without obscuring it with detach failure', async () => {
    const fixture = outputFixture()
    fixture.disposeOutput.mockImplementation(() => {
      throw new Error('detach failed')
    })
    const pending = waitForPtyOutput({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      expected: 'hvir-profile-smoke:structured',
      scenario: 'custom profile PTY output',
      trigger: () => fixture.order.push('trigger'),
    })
    fixture.emitData('partial-output')
    fixture.emitExit(127, 9)

    await expect(pending).rejects.toThrow(
      'custom profile PTY output exited before expected output ' +
        '(terminalId=profile-smoke-terminal, pid=9102, exitCode=127, signal=9, ' +
        'retainedOutput="partial-output")',
    )
    expect(fixture.disposeOutput).toHaveBeenCalledOnce()
  })

  it('detaches immediately when the subscribed output trigger fails', async () => {
    const fixture = outputFixture()

    await expect(
      waitForPtyOutput({
        supervisor: fixture.supervisor,
        terminal: fixture.terminal,
        expected: 'hvir-profile-smoke:structured',
        scenario: 'custom profile PTY output',
        trigger: () => {
          fixture.order.push('trigger')
          throw new Error('write failed')
        },
      }),
    ).rejects.toThrow('write failed')

    expect(fixture.order).toEqual(['attach', 'trigger', 'detach'])
    expect(fixture.disposeOutput).toHaveBeenCalledOnce()
  })
})

describe('smoke PTY lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('subscribes before termination and completes from the matching exit event', async () => {
    const fixture = lifecycleFixture()
    fixture.kill.mockImplementation(() => {
      fixture.order.push('kill')
      fixture.emitExit(fixture.terminal)
    })

    await stopPtyAndWaitForExit({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      scenario: 'custom-profile-pty-exit',
    })

    expect(fixture.order).toEqual(['subscribe', 'kill', 'exit', 'unsubscribe'])
    expect(fixture.kill).toHaveBeenCalledWith(
      fixture.terminal.id,
      fixture.terminal.ownerId,
      undefined,
      fixture.terminal.ownerGeneration,
    )
    expect(fixture.get).not.toHaveBeenCalled()
  })

  it('ignores other terminal exits while awaiting the target lifecycle event', async () => {
    const fixture = lifecycleFixture()
    fixture.kill.mockImplementation(() => {
      fixture.emitExit(managedPty('unrelated-terminal', 42))
      queueMicrotask(() => fixture.emitExit(fixture.terminal))
    })

    await stopPtyAndWaitForExit({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      scenario: 'custom-profile-pty-exit',
    })

    expect(fixture.disposeExit).toHaveBeenCalledOnce()
  })

  it('reports the last observed lifecycle state after the unchanged bound', async () => {
    vi.useFakeTimers()
    const fixture = lifecycleFixture()
    fixture.get.mockReturnValue(fixture.terminal)
    const pending = stopPtyAndWaitForExit({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      scenario: 'custom-profile-pty-exit',
      signal: 'SIGTERM',
      timeoutMs: 5_000,
      probeChildLiveness: () => 'alive',
    })

    const assertion = expect(pending).rejects.toThrow(
      'custom-profile-pty-exit timed out ' +
        '(terminalId=profile-smoke-terminal, pid=9102, requestedSignal=SIGTERM, ' +
        'elapsedMs=5000, exitCallbackFired=false, supervisorMember=true, ' +
        'childLiveness=alive)',
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(fixture.disposeExit).toHaveBeenCalledOnce()
  })

  it('bounds a stuck diagnostic probe without obscuring the lifecycle failure', async () => {
    vi.useFakeTimers()
    const fixture = lifecycleFixture()
    const pending = stopPtyAndWaitForExit({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      scenario: 'custom-profile-pty-exit',
      timeoutMs: 20,
      diagnosticProbeTimeoutMs: 10,
      probeChildLiveness: () => new Promise(() => undefined),
    })

    const assertion = expect(pending).rejects.toThrow(
      /custom-profile-pty-exit timed out .*childLiveness=unknown\(probe-timed-out\)/,
    )
    await vi.advanceTimersByTimeAsync(30)
    await assertion
    expect(fixture.disposeExit).toHaveBeenCalledOnce()
  })

  it('preserves a primary termination failure when subscription cleanup also fails', async () => {
    const fixture = lifecycleFixture()
    fixture.kill.mockImplementation(() => {
      throw new Error('termination failed')
    })
    fixture.disposeExit.mockImplementation(() => {
      throw new Error('unsubscribe failed')
    })

    await expect(
      stopPtyAndWaitForExit({
        supervisor: fixture.supervisor,
        terminal: fixture.terminal,
        scenario: 'custom-profile-pty-exit',
      }),
    ).rejects.toThrow('termination failed')
  })
})

function lifecycleFixture(): {
  readonly supervisor: LifecycleSupervisor
  readonly terminal: ManagedPty
  readonly get: ReturnType<typeof vi.fn<LifecycleSupervisor['get']>>
  readonly kill: ReturnType<typeof vi.fn<LifecycleSupervisor['kill']>>
  readonly disposeExit: ReturnType<typeof vi.fn<() => void>>
  readonly emitExit: (terminal: ManagedPty) => void
  readonly order: string[]
} {
  const order: string[] = []
  const terminal = managedPty('profile-smoke-terminal', 9102)
  const get = vi.fn<LifecycleSupervisor['get']>()
  const kill = vi.fn<LifecycleSupervisor['kill']>(() => {
    order.push('kill')
  })
  const disposeExit = vi.fn(() => {
    order.push('unsubscribe')
  })
  let exitCallback: ExitCallback | undefined
  const onExit = vi.fn<LifecycleSupervisor['onExit']>((callback) => {
    order.push('subscribe')
    exitCallback = callback
    return disposeExit
  })
  return {
    supervisor: { get, kill, onExit },
    terminal,
    get,
    kill,
    disposeExit,
    emitExit(info) {
      order.push('exit')
      exitCallback?.(info, { exitCode: 0, signal: undefined })
    },
    order,
  }
}

function outputFixture(): {
  readonly supervisor: OutputSupervisor
  readonly terminal: ManagedPty
  readonly attach: ReturnType<typeof vi.fn<OutputSupervisor['attach']>>
  readonly get: ReturnType<typeof vi.fn<OutputSupervisor['get']>>
  readonly disposeOutput: ReturnType<typeof vi.fn<() => void>>
  readonly emitData: (data: string) => void
  readonly emitExit: (exitCode: number, signal?: number) => void
  readonly order: string[]
} {
  const order: string[] = []
  const terminal = managedPty('profile-smoke-terminal', 9102)
  const get = vi.fn<OutputSupervisor['get']>()
  const disposeOutput = vi.fn(() => {
    order.push('detach')
  })
  let onData: ((data: string) => void) | undefined
  let onExit: ((exit: PtyExit) => void) | undefined
  const attach = vi.fn<OutputSupervisor['attach']>((_id, _ownerId, handlers) => {
    order.push('attach')
    onData = handlers.onData
    onExit = handlers.onExit
    return disposeOutput
  })
  return {
    supervisor: { attach, get },
    terminal,
    attach,
    get,
    disposeOutput,
    emitData(data) {
      order.push('data')
      onData?.(data)
    },
    emitExit(exitCode, signal) {
      order.push('exit')
      onExit?.({ exitCode, signal })
    },
    order,
  }
}

function managedPty(id: string, pid: number): ManagedPty {
  return {
    id,
    ownerId: 17,
    ownerGeneration: 3,
    hostId: asHostId('local'),
    cwd: localPath('/project'),
    workspaceRoot: localPath('/project'),
    providerId: asHarnessProviderId('custom-command'),
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    pid,
    startedAt: 1,
    resumed: false,
    identityStatus: 'none',
  }
}
