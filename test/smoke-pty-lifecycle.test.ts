import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startPtyProducer } from '../src/main/smoke/renderer-recovery-producer'

import type { PtyExit } from '../src/main/project-host'
import {
  stopPtyAndWaitForExit,
  waitForPtyOutput,
  type PtyOutputWaitProgress,
} from '../src/main/smoke/pty-lifecycle'
import type { ManagedPty, PtySupervisor } from '../src/main/pty/pty-supervisor'
import { asHarnessProviderId, asHostId, localPath } from '../src/shared'

type ExitCallback = Parameters<PtySupervisor['onExit']>[0]
type LifecycleSupervisor = Pick<PtySupervisor, 'get' | 'kill' | 'onExit'>
type OutputSupervisor = Pick<PtySupervisor, 'attach' | 'get'>

describe('smoke PTY output', () => {
  it.each(['deadline', 'interrupt'] as const)(
    'releases an unacknowledged output wait on %s',
    async (kind) => {
      const fixture = outputFixture()
      const controller = new AbortController()
      const progress: PtyOutputWaitProgress[] = []
      const pending = waitForPtyOutput({
        supervisor: fixture.supervisor,
        terminal: fixture.terminal,
        expected: 'never-emitted',
        scenario: 'capture readiness',
        trigger: vi.fn(),
        timeoutMs: 20,
        signal: controller.signal,
        onProgress: (state) => progress.push(state),
      })
      const rejected = expect(pending).rejects.toThrow(
        kind === 'deadline'
          ? 'timed out awaiting PTY acknowledgement'
          : 'output wait interrupted',
      )
      if (kind === 'interrupt') controller.abort()
      await rejected
      expect(fixture.disposeOutput).toHaveBeenCalledOnce()
      expect(progress.slice(-3).map((state) => state.phase)).toEqual([
        kind === 'deadline' ? 'timed-out' : 'interrupted',
        'detach-awaiting',
        'detach-returned',
      ])
    },
  )

  it.each(['replay', 'exit'] as const)(
    'does not trigger after synchronous attach %s settlement',
    async (kind) => {
      const fixture = outputFixture()
      const trigger = vi.fn()
      const progress: PtyOutputWaitProgress[] = []
      fixture.attach.mockImplementation((_id, _owner, handlers) => {
        if (kind === 'replay') handlers.onData?.('already-ready')
        else handlers.onExit?.({ exitCode: 127, signal: undefined })
        return fixture.disposeOutput
      })
      const result = waitForPtyOutput({
        supervisor: fixture.supervisor,
        terminal: fixture.terminal,
        expected: 'already-ready',
        scenario: 'synchronous attachment',
        trigger,
        onProgress: (state) => progress.push(state),
      })
      if (kind === 'replay') await expect(result).resolves.toBe('already-ready')
      else await expect(result).rejects.toThrow('exited before expected output')
      expect(trigger).not.toHaveBeenCalled()
      expect(fixture.disposeOutput).toHaveBeenCalledOnce()
      expect(progress.map((state) => state.phase)).toEqual(
        kind === 'replay'
          ? [
              'attach-awaiting',
              'first-output',
              'matched',
              'attach-returned',
              'detach-awaiting',
              'detach-returned',
            ]
          : [
              'attach-awaiting',
              'exited',
              'attach-returned',
              'detach-awaiting',
              'detach-returned',
            ],
      )
      expect(progress.at(-1)?.matched).toBe(kind === 'replay')
    },
  )

  it.each(['local', 'ssh'] as const)(
    'requires executed %s producer output, including cleanup',
    async (label) => {
      const fixture = outputFixture()
      fixture.get.mockReturnValue(fixture.terminal)
      const write = vi.fn<PtySupervisor['write']>()
      let ready = false
      const pending = startPtyProducer(
        { ...fixture.supervisor, write },
        fixture,
        label,
      ).then((dispose) => {
        ready = true
        return dispose
      })
      const command = write.mock.calls[0]![2]
      fixture.emitData(command)
      await Promise.resolve()
      expect(ready).toBe(false)
      fixture.emitData(`hvir-${label}-producer-ready\r\n`)
      const dispose = await pending
      let stopped = false
      const stopping = dispose().then(() => {
        stopped = true
      })
      const stopCommand = write.mock.calls[1]![2]
      fixture.emitData(stopCommand)
      await Promise.resolve()
      expect(stopped).toBe(false)
      expect(stopCommand).toBe('\u0003')
      fixture.emitData(`hvir-${label}-producer-stopped\r\n`)
      await stopping
      expect(fixture.disposeOutput).toHaveBeenCalledTimes(2)
      await dispose()
      expect(write).toHaveBeenCalledTimes(2)
    },
  )

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('bounds content-free progress while keeping attachment and trigger boundaries distinct', async () => {
    const fixture = outputFixture()
    const progress: PtyOutputWaitProgress[] = []
    const pending = waitForPtyOutput({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      expected: 'ready-marker',
      scenario: 'bounded progress',
      trigger: vi.fn(),
      onProgress: (state) => progress.push(state),
    })
    expect(progress.map((state) => state.phase)).toEqual([
      'attach-awaiting',
      'attach-returned',
      'trigger-awaiting',
      'trigger-returned',
    ])
    fixture.emitData('private terminal content')
    for (let index = 0; index < 100; index++) fixture.emitData('x'.repeat(1_000))
    fixture.emitData('ready-')
    fixture.emitData('marker')
    await pending
    expect(progress.map((state) => state.phase)).toEqual([
      'attach-awaiting',
      'attach-returned',
      'trigger-awaiting',
      'trigger-returned',
      'first-output',
      'output-cap',
      'matched',
      'detach-awaiting',
      'detach-returned',
    ])
    expect(progress.at(-1)).toEqual({
      phase: 'detach-returned',
      receivedCharacters: 4_096,
      matched: true,
    })
    expect(progress.every((state) => state.receivedCharacters <= 4_096)).toBe(true)
    expect(
      progress.every(
        (state) =>
          Object.keys(state).sort().join() === 'matched,phase,receivedCharacters',
      ),
    ).toBe(true)
    expect(JSON.stringify(progress)).not.toContain('private terminal content')
    expect(JSON.stringify(progress)).not.toContain('ready-marker')
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

  it('bounds retained output while allowing slow semantic success', async () => {
    const fixture = outputFixture()
    const pending = waitForPtyOutput({
      supervisor: fixture.supervisor,
      terminal: fixture.terminal,
      expected: 'eventual-output',
      scenario: 'custom profile PTY output',
      trigger: () => fixture.order.push('trigger'),
    })
    fixture.emitData(`discarded-prefix${'x'.repeat(5_000)}`)
    await Promise.resolve()
    fixture.emitData('eventual-output')

    const retained = await pending
    expect(retained).toContain('eventual-output')
    expect(retained).not.toContain('discarded-prefix')
    expect(retained.length).toBeLessThanOrEqual(4_096)
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
        'retainedCharacters=14)',
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
    instanceId: `instance-${id}-${pid}`,
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
