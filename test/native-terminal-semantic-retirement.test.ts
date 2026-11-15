import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalSemanticRetirement } from '../src/main/terminal/native-terminal-semantic-retirement'
import type { NativeBoundarySource } from '../src/main/terminal/native-terminal-query-boundaries'
import { localPath } from '../src/shared/host-path'

function source(instanceId = 'surface-a', ownerId = 1): NativeBoundarySource {
  return {
    handle: `native-${instanceId}`,
    session: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      instanceId,
      ownerId,
      ownerGeneration: 1,
      workspaceRoot: localPath('/tmp/semantic-retirement'),
    },
    assertCurrent() {},
  }
}
function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('native semantic pin retirement', () => {
  it('retains a paused and failed close until a causal wake retries its exact token', async () => {
    const a = source()
    const held = deferred()
    const close = vi
      .fn<(_source: NativeBoundarySource, token: string) => Promise<void>>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(undefined)
    const failed = vi.fn()
    const owner = new NativeTerminalSemanticRetirement(close, failed)
    owner.observe(a, 'opaque-parser-token', 10)
    owner.retire(a, 'opaque-parser-token')
    owner.retire(a, 'opaque-parser-token')
    owner.wake(a)
    await flush()
    expect(close).toHaveBeenCalledExactlyOnceWith(a, 'opaque-parser-token')
    held.reject(new Error('physical close paused'))
    await flush()
    expect(failed).toHaveBeenCalledExactlyOnceWith(a)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).toHaveBeenCalledTimes(1)

    const transferred = source('surface-a', 2)
    owner.wake(transferred)
    await flush()
    expect(close).toHaveBeenNthCalledWith(2, transferred, 'opaque-parser-token')
    owner.wake(transferred)
    owner.retire(transferred, 'opaque-parser-token')
    await flush()
    expect(close).toHaveBeenCalledTimes(2)
    owner.forgetDestroyed(a.session.instanceId)
  })

  it('requires 512 distinct later captures on the same Surface to certify replacement', async () => {
    const a = source()
    const b = source('surface-b')
    const attempts: ReturnType<typeof deferred>[] = []
    const close = vi.fn((_source: NativeBoundarySource, _token: string) => {
      const attempt = deferred()
      attempts.push(attempt)
      return attempt.promise
    })
    const failed = vi.fn()
    const owner = new NativeTerminalSemanticRetirement(close, failed)
    owner.observe(a, 'original', 1000)
    owner.retire(a, 'original')
    await flush()
    for (let i = 1; i <= 512; i++) {
      owner.observe(a, 'original', 1000 + i) // Duplicate tokens do not count.
      owner.observe(a, `older-${i}`, i)
      owner.observe(b, `other-${i}`, 1000 + i)
    }
    attempts[0]!.reject(new Error('still owned'))
    await flush()
    expect(failed).toHaveBeenCalledTimes(1)
    owner.wake(a)
    await flush()
    expect(close).toHaveBeenNthCalledWith(2, a, 'original')
    for (let i = 1; i < 512; i++) owner.observe(a, `later-${i}`, 1000 + i)
    attempts[1]!.reject(new Error('only 511 later captures'))
    await flush()
    expect(failed).toHaveBeenCalledTimes(2)
    owner.wake(a)
    await flush()
    expect(close).toHaveBeenNthCalledWith(3, a, 'original')
    owner.observe(a, 'later-512', 1512)
    attempts[2]!.reject(new Error('already physically replaced'))
    await flush()
    expect(failed).toHaveBeenCalledTimes(2)
    owner.retire(a, 'original')
    owner.observe(a, 'original', 1000) // Older replay cannot recreate ownership.
    owner.retire(a, 'original')
    owner.wake(a)
    expect(close).toHaveBeenCalledTimes(3)
    owner.forgetDestroyed(a.session.instanceId)
    owner.forgetDestroyed(b.session.instanceId)
  })

  it.each(['resolved', 'rejected'] as const)(
    'drops destroyed Surface ownership safely when its paused close is later %s',
    async (outcome) => {
      const a = source()
      const b = source('surface-b')
      const held = deferred()
      const close = vi
        .fn<(_source: NativeBoundarySource, token: string) => Promise<void>>()
        .mockReturnValueOnce(held.promise)
        .mockResolvedValue(undefined)
      const failed = vi.fn()
      const owner = new NativeTerminalSemanticRetirement(close, failed)
      owner.observe(a, 'old', 1)
      owner.retire(a, 'old')
      await flush()
      owner.forgetDestroyed(a.session.instanceId)
      owner.forgetDestroyed(a.session.instanceId)
      owner.wake(a)
      if (outcome === 'resolved') held.resolve()
      else held.reject(new Error('destroyed before close completed'))
      await flush()
      expect(failed).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
      owner.observe(b, 'current', 1)
      owner.retire(b, 'current')
      await flush()
      expect(close).toHaveBeenNthCalledWith(2, b, 'current')
      owner.forgetDestroyed(b.session.instanceId)
    },
  )

  it('contains a throwing failure observer while retaining cleanup for a later wake', async () => {
    const a = source()
    const close = vi
      .fn<(_source: NativeBoundarySource, token: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('native close refused'))
      .mockResolvedValue(undefined)
    const failed = vi.fn(() => {
      throw new Error('observer failed')
    })
    const owner = new NativeTerminalSemanticRetirement(close, failed)
    owner.observe(a, 'retained', 1)
    owner.retire(a, 'retained')
    await flush()
    expect(failed).toHaveBeenCalledExactlyOnceWith(a)
    owner.wake(a)
    await flush()
    expect(close).toHaveBeenNthCalledWith(2, a, 'retained')
    owner.wake(a)
    expect(close).toHaveBeenCalledTimes(2)
    owner.forgetDestroyed(a.session.instanceId)
  })
})
