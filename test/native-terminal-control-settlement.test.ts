import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { PtyWriteResourceSettlementError } from '../src/main/project-host/project-host'
import { PtySessionObservation } from '../src/main/pty/pty-session-observation'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import {
  createPtySupervisorFixture,
  plainShellProvider,
} from './fixtures/pty-supervisor-fixture'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('captured native control transport settlement', () => {
  it('preserves the exact control receipt through input closure while parser replies let final output drain', async () => {
    const retryAfterInput = vi.spyOn(PtySessionObservation.prototype, 'retryAfterInput')
    onTestFinished(() => retryAfterInput.mockRestore())
    const f = createPtySupervisorFixture({ provider: plainShellProvider })
    const status = nativeTerminalStatus()
    const host = {
      prepare: vi.fn(() => Promise.resolve('handle')),
      appearanceProducer: vi.fn(() => Promise.resolve(status)),
      inspectProducer: vi.fn(() => Promise.resolve(status)),
      resizeProducer: vi.fn(() => Promise.resolve(status)),
      feed: vi.fn(() => Promise.resolve()),
      drainReplies: vi.fn(() => Promise.resolve(Uint8Array.of(9))),
      drainEffectsProducer: vi.fn(() =>
        Promise.resolve({ effects: [], droppedEffects: 0, semanticGeneration: 0 }),
      ),
      end: vi.fn(() => Promise.resolve()),
    }
    const unavailable = vi.fn()
    const sessions = new NativeTerminalSessions(host, () => true, unavailable)
    const info = await f.spawn({
      prepareTerminal: (reservation, signal) =>
        sessions.prepare(reservation, signal, {
          width: 32,
          height: 32,
          backingScale: 1,
        }),
    })
    let inputClosed = false
    Object.defineProperty(f.pty, 'inputClosed', { get: () => inputClosed })
    const controlWrite = deferred<void>(),
      replyWrite = deferred<void>()
    const controlResources = deferred<void>(),
      replyResources = deferred<void>()
    f.pty.writeConfirmed
      .mockReturnValueOnce(controlWrite.promise)
      .mockReturnValueOnce(replyWrite.promise)
    const controlBytes = Uint8Array.of(1, 2)
    const control = sessions
      .writeControl(info.id, info.instanceId, controlBytes)
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.pty.writeConfirmed).toHaveBeenCalledOnce())
    f.pty.emitData('admitted final parser output')
    await vi.waitFor(() => expect(f.pty.writeConfirmed).toHaveBeenCalledTimes(2))
    expect(f.pty.writeConfirmed.mock.calls).toEqual([[controlBytes], [Uint8Array.of(9)]])
    const controlFailure = new PtyWriteResourceSettlementError(
      'control-input-closed',
      controlResources.promise,
    )
    const replyFailure = new PtyWriteResourceSettlementError(
      'reply-input-closed',
      replyResources.promise,
    )
    let controlSettled = false,
      replySettled = false
    void controlResources.promise.then(() => {
      controlSettled = true
    })
    void replyResources.promise.then(() => {
      replySettled = true
    })
    inputClosed = true
    controlWrite.reject(controlFailure)
    replyWrite.reject(replyFailure)
    expect(await control).toBe(controlFailure)
    f.pty.emitExit({ exitCode: 0, signal: undefined })
    await vi.waitFor(() =>
      expect(sessions.get(info.id)).toMatchObject({
        readonly: true,
        inputClosed: true,
        inputUnavailable: false,
        unavailable: false,
      }),
    )
    expect(f.supervisor.get(info.id)).toBeUndefined()
    expect(host.feed).toHaveBeenCalledOnce()
    expect(unavailable).not.toHaveBeenCalled()
    expect(host.end).not.toHaveBeenCalled()
    expect(controlSettled).toBe(false)
    expect(replySettled).toBe(false)
    // Refusing a new control before issuance cannot settle the older write.
    await sessions.writeControl(info.id, info.instanceId, Uint8Array.of(3))
    expect(f.pty.writeConfirmed).toHaveBeenCalledTimes(2)
    expect(retryAfterInput).not.toHaveBeenCalled()
    expect(controlSettled).toBe(false)
    await sessions.remove(info.id, info.instanceId)
    expect(sessions.get(info.id)).toBeUndefined()
    expect(controlSettled).toBe(false)
    controlResources.resolve()
    await controlFailure.resourceSettlement
    expect(controlSettled).toBe(true)
    expect(replySettled).toBe(false)
    replyResources.resolve()
    await replyFailure.resourceSettlement
    expect(replySettled).toBe(true)
    expect(host.end).toHaveBeenCalledExactlyOnceWith('handle', info.instanceId)
    expect(f.pty.writeConfirmed).toHaveBeenCalledTimes(2)
    expect(f.pty.dataListeners.size).toBe(0)
    expect(f.pty.exitListeners.size).toBe(0)
  })
})
