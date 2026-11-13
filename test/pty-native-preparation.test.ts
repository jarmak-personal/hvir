import { describe, expect, it, vi } from 'vitest'
import type {
  PtyPreparedTerminal,
  PtyTerminalReservation,
} from '../src/main/pty/pty-contract'
import { PtySessionObservation } from '../src/main/pty/pty-session-observation'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import { createPtySupervisorFixture } from './fixtures/pty-supervisor-fixture'

function prepared() {
  return {
    columns: 101,
    rows: 37,
    connect: vi.fn<PtyPreparedTerminal['connect']>(),
    output: vi.fn<PtyPreparedTerminal['output']>().mockResolvedValue(),
    exited: vi.fn<PtyPreparedTerminal['exited']>().mockResolvedValue(),
    failed: vi.fn<PtyPreparedTerminal['failed']>(),
    dispose: vi.fn<PtyPreparedTerminal['dispose']>().mockResolvedValue(),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('supervisor native preparation boundary', () => {
  it('uses the reserved identity and applied geometry before composing or spawning a shell', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const { spawnPty: spawnProcess } = f
    const native = prepared(),
      pending = deferred<PtyPreparedTerminal>()
    const prepare = vi
      .fn<
        (
          reservation: PtyTerminalReservation,
          signal: AbortSignal,
        ) => Promise<PtyPreparedTerminal>
      >()
      .mockReturnValue(pending.promise)
    const launch = vi
      .fn()
      .mockResolvedValue({ file: '/actual/shell', args: ['applied-size'] })
    const started = f.spawn({
      cols: 80,
      rows: 24,
      ownerGeneration: 7,
      prepareTerminal: prepare,
      resolveLaunchSpec: launch,
    })
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    pending.resolve(native)
    const info = await started
    expect(prepare.mock.calls[0]![0]).toEqual({
      sessionId: info.id,
      instanceId: info.instanceId,
      ownerId: info.ownerId,
      ownerGeneration: 7,
      workspaceRoot: info.workspaceRoot,
    })
    expect(launch).toHaveBeenCalledExactlyOnceWith({ cols: 101, rows: 37 })
    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        file: '/actual/shell',
        args: ['applied-size'],
        cols: 101,
        rows: 37,
      }),
    )
    expect(native.connect).toHaveBeenCalledOnce()
    expect(f.pty.dataListeners.size).toBe(1)
  })
  it('disposes cancelled late preparation without launching and rejects invalid acknowledged geometry', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const { spawnPty: spawnProcess } = f
    const native = prepared(),
      pending = deferred<PtyPreparedTerminal>(),
      controller = new AbortController()
    const prepare = vi.fn().mockReturnValue(pending.promise)
    const started = f.spawn({ signal: controller.signal, prepareTerminal: prepare })
    const rejected = expect(started).rejects.toThrow()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    controller.abort()
    pending.resolve(native)
    await rejected
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(native.dispose).toHaveBeenCalledOnce()
    const invalid = { ...prepared(), columns: 0 }
    await expect(
      f.spawn({ prepareTerminal: () => Promise.resolve(invalid) }),
    ).rejects.toThrow('geometry-invalid')
    expect(invalid.dispose).toHaveBeenCalledOnce()
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it('disposes preparation after launch resolution fails or a late physical spawn is cancelled', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const { spawnPty: spawnProcess } = f
    const failed = prepared()
    await expect(
      f.spawn({
        prepareTerminal: () => Promise.resolve(failed),
        resolveLaunchSpec: () => Promise.reject(new Error('launch refused')),
      }),
    ).rejects.toThrow('launch refused')
    expect(failed.dispose).toHaveBeenCalledOnce()
    expect(spawnProcess).not.toHaveBeenCalled()
    const native = prepared(),
      physical = f.deferNextSpawn(),
      controller = new AbortController()
    const started = f.spawn({
      signal: controller.signal,
      prepareTerminal: () => Promise.resolve(native),
    })
    const rejected = expect(started).rejects.toThrow()
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    controller.abort()
    physical.resolve()
    await rejected
    expect(physical.pty.kill).toHaveBeenCalledOnce()
    expect(native.dispose).toHaveBeenCalledOnce()
  })
  it('feeds once independently of renderer replay and drains admitted exit tail before read-only', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      pending = deferred<void>()
    native.output.mockReturnValueOnce(pending.promise)
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    expect(writer.live).toBe(true)
    f.pty.emitData('before attach')
    await flush()
    expect(f.pty.pause).toHaveBeenCalledOnce()
    const first = vi.fn(),
      second = vi.fn()
    const stop = f.supervisor.attach(info.id, info.ownerId, { onData: first })
    expect(first).toHaveBeenCalledExactlyOnceWith('before attach')
    await stop()
    f.supervisor.attach(info.id, info.ownerId, { onData: second })
    expect(second).not.toHaveBeenCalled()
    expect(native.output).toHaveBeenCalledExactlyOnceWith('before attach')
    const exit = { exitCode: 0, signal: undefined }
    f.pty.emitExit(exit)
    expect(writer.live).toBe(false)
    await writer.writeReply(Uint8Array.of(0, 255))
    expect(f.pty.writeConfirmed).not.toHaveBeenCalled()
    expect(native.exited).not.toHaveBeenCalled()
    pending.resolve()
    await flush()
    expect(native.exited).toHaveBeenCalledExactlyOnceWith(exit)
    expect(native.dispose).not.toHaveBeenCalled()
  })
  it('confirms raw replies only into the exact live instance and never a reused session', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared()
    const info = await f.spawn({
      sessionId: 'reused',
      ownerGeneration: 7,
      prepareTerminal: () => Promise.resolve(native),
    })
    const writer = native.connect.mock.calls[0]![0]
    const bytes = Uint8Array.of(0, 128, 255)
    await writer.writeReply(bytes)
    expect(f.pty.writeConfirmed).toHaveBeenCalledExactlyOnceWith(bytes)
    f.supervisor.disposeSession(info.id, info.ownerId, 7)
    await flush()
    expect(native.dispose).toHaveBeenCalledOnce()
    const replacement = f.deferNextSpawn()
    const started = f.spawn({ sessionId: 'reused', ownerGeneration: 8 })
    replacement.resolve()
    await started
    await writer.writeReply(bytes)
    expect(replacement.pty.writeConfirmed).not.toHaveBeenCalled()
  })
  it('completes a native reply across renderer rollover without a user-input observation', async () => {
    const retry = vi.spyOn(PtySessionObservation.prototype, 'retryAfterInput')
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      ack = deferred<void>()
    const info = await f.spawn({
      ownerGeneration: 7,
      prepareTerminal: () => Promise.resolve(native),
    })
    f.supervisor.attach(info.id, info.ownerId, { onData: vi.fn() }, 7)
    const writer = native.connect.mock.calls[0]![0]
    f.pty.writeConfirmed.mockReturnValueOnce(ack.promise)
    const bytes = Uint8Array.of(0, 128, 255)
    const reply = writer.writeReply(bytes)
    expect(
      f.supervisor.transferRendererSession(info.id, info.ownerId, 7, info.ownerId + 1, 8),
    ).toBe(true)
    ack.resolve()
    await expect(reply).resolves.toBeUndefined()
    expect(writer.live).toBe(true)
    expect(f.supervisor.get(info.id)?.instanceId).toBe(info.instanceId)
    expect(f.pty.writeConfirmed).toHaveBeenCalledExactlyOnceWith(bytes)
    expect(retry).not.toHaveBeenCalled()
    retry.mockRestore()
  })
  it('drains admitted output when physical exit rejects an in-flight reply', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      ack = deferred<void>()
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    f.pty.writeConfirmed.mockReturnValueOnce(ack.promise)
    native.output.mockImplementation(() => writer.writeReply(Uint8Array.of(255)))
    f.pty.emitData('final report')
    await flush()
    expect(f.pty.writeConfirmed).toHaveBeenCalledOnce()
    const exit = { exitCode: 0, signal: undefined }
    f.pty.emitExit(exit)
    ack.reject(new Error('physical transport exited'))
    await flush()
    expect(native.failed).not.toHaveBeenCalled()
    expect(native.exited).toHaveBeenCalledExactlyOnceWith(exit)
    const replacement = f.deferNextSpawn()
    const started = f.spawn({ sessionId: info.id })
    replacement.resolve()
    await started
    await writer.writeReply(Uint8Array.of(254))
    expect(replacement.pty.writeConfirmed).not.toHaveBeenCalled()
    expect(f.pty.writeConfirmed).toHaveBeenCalledOnce()
  })
  it('keeps output alive while known input closure suppresses stale native replies', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared()
    let inputClosed = false
    Object.defineProperty(f.pty, 'inputClosed', { get: () => inputClosed })
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    expect(writer.live).toBe(true)
    inputClosed = true
    expect(writer.live).toBe(false)
    await writer.writeReply(Uint8Array.of(255))
    expect(f.pty.writeConfirmed).not.toHaveBeenCalled()
    f.pty.emitData('remote output after status')
    await flush()
    expect(native.output).toHaveBeenCalledExactlyOnceWith('remote output after status')
    expect(f.supervisor.get(info.id)?.instanceId).toBe(info.instanceId)
    expect(native.failed).not.toHaveBeenCalled()
    expect(native.exited).not.toHaveBeenCalled()
  })
  it('does not fail retained output when input closes during a native reply write', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      ack = deferred<void>()
    let inputClosed = false
    Object.defineProperty(f.pty, 'inputClosed', { get: () => inputClosed })
    await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    f.pty.writeConfirmed.mockReturnValueOnce(ack.promise)
    native.output.mockImplementation(() => writer.writeReply(Uint8Array.of(255)))
    f.pty.emitData('accepted final query')
    await flush()
    expect(f.pty.writeConfirmed).toHaveBeenCalledOnce()
    inputClosed = true
    ack.reject(new Error('known remote input ended'))
    await flush()
    expect(native.failed).not.toHaveBeenCalled()
    expect(native.exited).not.toHaveBeenCalled()
    f.pty.emitExit({ exitCode: 7, signal: undefined })
    await flush()
    expect(native.exited).toHaveBeenCalledExactlyOnceWith({
      exitCode: 7,
      signal: undefined,
    })
  })
  it('rejects an indeterminate reply failure while its exact PTY remains live', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      ack = deferred<void>()
    await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    f.pty.writeConfirmed.mockReturnValueOnce(ack.promise)
    const reply = writer.writeReply(Uint8Array.of(255))
    const rejected = expect(reply).rejects.toThrow('indeterminate write')
    ack.reject(new Error('indeterminate write'))
    await rejected
    expect(writer.live).toBe(true)
  })
  it('connects the exact native sink before a synchronous initial source burst', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared()
    vi.spyOn(f.pty, 'onData').mockImplementation((listener) => {
      expect(native.connect).toHaveBeenCalledOnce()
      listener('initial burst')
      return () => undefined
    })
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    await flush()
    expect(native.output).toHaveBeenCalledExactlyOnceWith('initial burst')
    const renderer = vi.fn()
    f.supervisor.attach(info.id, info.ownerId, { onData: renderer })
    expect(renderer).toHaveBeenCalledExactlyOnceWith('initial burst')
    expect(native.output).toHaveBeenCalledOnce()
  })
  it('requires physical pause support only for prepared native output', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    Object.defineProperty(f.pty, 'pause', { value: undefined })
    const native = prepared()
    await expect(
      f.spawn({ prepareTerminal: () => Promise.resolve(native) }),
    ).rejects.toThrow('flow-control-unavailable')
    expect(f.pty.kill).toHaveBeenCalledOnce()
    expect(native.dispose).toHaveBeenCalledOnce()
    expect(f.supervisor.list()).toHaveLength(0)
    await expect(f.spawn()).resolves.toBeDefined()
  })
  it('revokes live reply authority before explicit disposal waits for active native output', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared(),
      active = deferred<void>()
    native.output.mockReturnValueOnce(active.promise)
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const writer = native.connect.mock.calls[0]![0]
    f.pty.emitData('active')
    await flush()
    f.supervisor.disposeSession(info.id, info.ownerId)
    expect(writer.live).toBe(false)
    expect(native.dispose).not.toHaveBeenCalled()
    await writer.writeReply(Uint8Array.of(255))
    expect(f.pty.writeConfirmed).not.toHaveBeenCalled()
    active.resolve()
    await flush()
    expect(native.dispose).toHaveBeenCalledOnce()
  })

  it('marks native overrun unavailable but leaves the original renderer and PTY usable', async () => {
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const native = prepared()
    const info = await f.spawn({ prepareTerminal: () => Promise.resolve(native) })
    const output = vi.fn()
    f.supervisor.attach(info.id, info.ownerId, { onData: output })
    f.pty.emitData('x'.repeat(131073))
    expect(native.failed).toHaveBeenCalledOnce()
    expect(f.pty.kill).not.toHaveBeenCalled()
    f.pty.emitData('later')
    expect(output).toHaveBeenLastCalledWith('later')
    expect(native.output).not.toHaveBeenCalled()
    expect(f.supervisor.get(info.id)).toBeDefined()
  })
})
