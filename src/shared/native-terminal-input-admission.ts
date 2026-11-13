import { NativeTerminalAdmissionError } from './native-terminal'
import {
  NATIVE_INPUT_RESULTS,
  NativeTerminalInputResourceRefused,
} from './native-terminal-input'

export interface NativeTerminalInputResultCredit {
  readonly capacity: number
  release(): void
}

/** Concurrent result ownership, never a paste-source size limit or command queue. */
export class NativeTerminalInputResultCredits {
  private ordinaryBytes = 0
  private pasteCount = 0
  private oversizedPasteCapacity = 0

  reserve(
    capacity: number,
    paste = false,
    cleanup = false,
  ): NativeTerminalInputResultCredit {
    if (!Number.isSafeInteger(capacity) || capacity < 0)
      throw new NativeTerminalInputResourceRefused('native-input-capacity-overflow')
    const ordinaryMaximum =
      NATIVE_INPUT_RESULTS.aggregateBytes - NATIVE_INPUT_RESULTS.cleanupBytes
    const oversized = paste && capacity > ordinaryMaximum
    const maximum = cleanup ? NATIVE_INPUT_RESULTS.aggregateBytes : ordinaryMaximum
    if (
      (paste && this.oversizedPasteCapacity !== 0) ||
      (oversized ? this.pasteCount !== 0 : capacity > maximum - this.ordinaryBytes)
    )
      throw new NativeTerminalAdmissionError('native-input-capacity')
    if (oversized) this.oversizedPasteCapacity = capacity
    else this.ordinaryBytes += capacity
    if (paste) this.pasteCount++
    let released = false
    return {
      capacity,
      release: () => {
        if (released) return
        released = true
        if (oversized) this.oversizedPasteCapacity = 0
        else this.ordinaryBytes -= capacity
        if (paste) this.pasteCount--
      },
    }
  }
}
