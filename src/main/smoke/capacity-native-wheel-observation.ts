import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { NativeTerminalInputCompletion } from '../../shared/native-terminal-input'

type NativeInputOwner = Pick<NativeTerminalApplication, 'input'>
type WheelScope = { viewId: string; owner: { id: number; generation: number } }
export interface CapacityNativeWheelReceipt {
  readonly sequence: number
  readonly requestedMutation?: number
  readonly refused?: 'capacity'
  readonly failed?: true
}
interface WheelArm extends WheelScope {
  sequence: number
  receipt?: CapacityNativeWheelReceipt
}

/** One gesture's real native input completion; no parser, frame or pixel authority. */
export function observeCapacityNativeWheel(native: NativeInputOwner) {
  const original = native.input
  const descriptor = Object.getOwnPropertyDescriptor(native, 'input')
  let active: WheelArm | undefined
  let sequence = 0
  let disposed = false
  const wrapped: NativeInputOwner['input'] = function (this: NativeInputOwner, ...args) {
    const captured = active
    const matching =
      captured &&
      args[0] === captured.viewId &&
      args[1].id === captured.owner.id &&
      args[1].generation === captured.owner.generation &&
      args[2].kind === 'wheel'
        ? captured
        : undefined
    const observedSequence = matching ? ++sequence : undefined
    if (matching && observedSequence !== undefined) {
      matching.sequence = observedSequence
      matching.receipt = undefined
    }
    const current = () =>
      !disposed &&
      !!matching &&
      active === matching &&
      matching.sequence === observedSequence
    let result: ReturnType<NativeInputOwner['input']>
    try {
      result = original.apply(this, args)
    } catch (error) {
      if (current()) matching!.receipt = { sequence: observedSequence!, failed: true }
      throw error
    }
    if (matching && observedSequence !== undefined) {
      void result
        .then(
          (completion: NativeTerminalInputCompletion) => {
            if (!current()) return
            matching.receipt = {
              sequence: observedSequence,
              requestedMutation: completion.requestedMutation,
              ...(completion.refused ? { refused: completion.refused } : {}),
            }
          },
          () => {
            if (current()) matching.receipt = { sequence: observedSequence, failed: true }
          },
        )
        .catch(() => undefined)
    }
    return result
  }
  Object.defineProperty(
    native,
    'input',
    descriptor && 'value' in descriptor
      ? { ...descriptor, value: wrapped }
      : {
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
          writable: true,
          value: wrapped,
        },
  )
  return {
    arm(scope: WheelScope) {
      if (disposed) throw new Error('capacity-native-wheel-observer-disposed')
      const state: WheelArm = {
        viewId: scope.viewId,
        owner: { ...scope.owner },
        sequence: 0,
      }
      active = state
      return {
        read: (): CapacityNativeWheelReceipt | undefined =>
          state.receipt && active === state && !disposed
            ? { ...state.receipt }
            : undefined,
        close() {
          if (active === state) active = undefined
        },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = undefined
      if (Object.getOwnPropertyDescriptor(native, 'input')?.value !== wrapped) return
      if (descriptor) Object.defineProperty(native, 'input', descriptor)
      else delete (native as Partial<NativeInputOwner>).input
    },
  }
}
