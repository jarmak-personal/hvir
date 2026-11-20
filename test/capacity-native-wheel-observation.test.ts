import { describe, expect, it, vi } from 'vitest'
import type { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import type { NativeTerminalInputCompletion } from '../src/shared/native-terminal-input'
import { observeCapacityNativeWheel } from '../src/main/smoke/capacity-native-wheel-observation'

type NativeInput = Pick<NativeTerminalApplication, 'input'>
const scope = { viewId: 'view-a', owner: { id: 1, generation: 2 } }
const wheel = {
  kind: 'wheel' as const,
  x: 1,
  y: 2,
  deltaX: 0,
  deltaY: 40,
  precision: true,
  modifiers: 0,
}
function deferred() {
  let resolve!: (value: NativeTerminalInputCompletion) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<NativeTerminalInputCompletion>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const input = vi.fn<NativeInput['input']>(() =>
    Promise.resolve({ requestedMutation: 7 }),
  )
  const native: NativeInput = { input }
  const observer = observeCapacityNativeWheel(native)
  return { native, input, observer }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('capacity native wheel completion observation', () => {
  it('counts real matching calls only and preserves the original result, arguments and this', async () => {
    const f = fixture(),
      arm = f.observer.arm(scope)
    await f.native.input('other', scope.owner, wheel)
    await f.native.input(scope.viewId, { id: 9, generation: 2 }, wheel)
    await f.native.input(scope.viewId, { id: 1, generation: 3 }, wheel)
    await f.native.input(scope.viewId, scope.owner, { kind: 'caret' })
    expect(arm.read()).toBeUndefined()
    const completion = { requestedMutation: 41 },
      pending = Promise.resolve(completion)
    f.input.mockReturnValueOnce(pending)
    const result = f.native.input(scope.viewId, scope.owner, wheel)
    expect(result).toBe(pending)
    expect(await result).toBe(completion)
    await settle()
    expect(f.input.mock.contexts.every((value) => value === f.native)).toBe(true)
    expect(f.input).toHaveBeenLastCalledWith(scope.viewId, scope.owner, wheel)
    expect(arm.read()).toEqual({ sequence: 1, requestedMutation: 41 })
    await f.native.input(scope.viewId, scope.owner, wheel)
    await settle()
    expect(arm.read()).toEqual({ sequence: 2, requestedMutation: 7 })
    f.observer.dispose()
  })

  it('keeps actual refusal distinct from a successful mutation', async () => {
    const f = fixture(),
      arm = f.observer.arm(scope)
    const completion = { requestedMutation: 0, refused: 'capacity' as const }
    f.input.mockResolvedValueOnce(completion)
    expect(await f.native.input(scope.viewId, scope.owner, wheel)).toBe(completion)
    await settle()
    expect(arm.read()).toEqual({ sequence: 1, requestedMutation: 0, refused: 'capacity' })
    f.observer.dispose()
  })

  it.each(['synchronous', 'asynchronous'] as const)(
    'preserves %s failure identity without inventing a serial',
    async (kind) => {
      const f = fixture(),
        arm = f.observer.arm(scope),
        failure = new Error('original')
      if (kind === 'synchronous') {
        f.input.mockImplementationOnce(() => {
          throw failure
        })
        let caught: unknown
        try {
          void f.native.input(scope.viewId, scope.owner, wheel)
        } catch (error) {
          caught = error
        }
        expect(caught).toBe(failure)
      } else {
        const pending = Promise.reject(failure)
        f.input.mockReturnValueOnce(pending)
        expect(f.native.input(scope.viewId, scope.owner, wheel)).toBe(pending)
        await expect(pending).rejects.toBe(failure)
      }
      await settle()
      expect(arm.read()).toEqual({ sequence: 1, failed: true })
      f.observer.dispose()
    },
  )

  it.each(['close', 'new-arm', 'dispose'] as const)(
    'ignores late results after %s and does not affect a successor arm',
    async (boundary) => {
      const f = fixture(),
        old = f.observer.arm(scope),
        pending = deferred()
      f.input.mockReturnValueOnce(pending.promise)
      const result = f.native.input(scope.viewId, scope.owner, wheel)
      if (boundary === 'close') old.close()
      if (boundary === 'dispose') f.observer.dispose()
      const fresh = boundary === 'dispose' ? undefined : f.observer.arm(scope)
      if (fresh) {
        await f.native.input(scope.viewId, scope.owner, wheel)
        await settle()
        expect(fresh.read()).toEqual({ sequence: 2, requestedMutation: 7 })
      }
      pending.resolve({ requestedMutation: 99 })
      await result
      await settle()
      expect(old.read()).toBeUndefined()
      if (fresh) expect(fresh.read()).toEqual({ sequence: 2, requestedMutation: 7 })
      f.observer.dispose()
    },
  )

  it('ignores a late rejection after a successor arm is installed', async () => {
    const f = fixture(),
      old = f.observer.arm(scope),
      pending = deferred()
    f.input.mockReturnValueOnce(pending.promise)
    const result = f.native.input(scope.viewId, scope.owner, wheel)
    const fresh = f.observer.arm(scope),
      failure = new Error('late-original')
    await f.native.input(scope.viewId, scope.owner, wheel)
    pending.reject(failure)
    await expect(result).rejects.toBe(failure)
    await settle()
    expect(old.read()).toBeUndefined()
    expect(fresh.read()).toEqual({ sequence: 2, requestedMutation: 7 })
    f.observer.dispose()
  })

  it('does not let an older completion overwrite the most recently dispatched call', async () => {
    const f = fixture(),
      arm = f.observer.arm(scope),
      pending = deferred()
    f.input.mockReturnValueOnce(pending.promise)
    const first = f.native.input(scope.viewId, scope.owner, wheel)
    await f.native.input(scope.viewId, scope.owner, wheel)
    await settle()
    expect(arm.read()).toEqual({ sequence: 2, requestedMutation: 7 })
    pending.resolve({ requestedMutation: 4 })
    await first
    await settle()
    expect(arm.read()).toEqual({ sequence: 2, requestedMutation: 7 })
    f.observer.dispose()
  })

  it('restores the exact own method descriptor and leaves a later replacement alone', () => {
    const input = vi.fn<NativeInput['input']>(() =>
      Promise.resolve({ requestedMutation: 1 }),
    )
    const native = {} as NativeInput
    Object.defineProperty(native, 'input', {
      value: input,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    const descriptor = Object.getOwnPropertyDescriptor(native, 'input')
    const first = observeCapacityNativeWheel(native)
    first.dispose()
    first.dispose()
    expect(Object.getOwnPropertyDescriptor(native, 'input')).toEqual(descriptor)
    const second = observeCapacityNativeWheel(native),
      replacement = vi.fn(input)
    native.input = replacement
    second.dispose()
    expect(native.input).toBe(replacement)
  })

  it('removes only its own shadow property and preserves the prototype method descriptor', () => {
    class Native {
      input: NativeInput['input'] = () => Promise.resolve({ requestedMutation: 1 })
    }
    const original = new Native().input
    Object.defineProperty(Native.prototype, 'input', {
      value: original,
      configurable: true,
      writable: true,
      enumerable: false,
    })
    const native: NativeInput = Object.create(Native.prototype) as NativeInput
    const descriptor = Object.getOwnPropertyDescriptor(Native.prototype, 'input')
    const observed = observeCapacityNativeWheel(native)
    observed.dispose()
    expect(Object.hasOwn(native, 'input')).toBe(false)
    expect(native.input).toBe(original)
    expect(Object.getOwnPropertyDescriptor(Native.prototype, 'input')).toEqual(descriptor)
    expect(() => observed.arm(scope)).toThrow('observer-disposed')
  })
})
