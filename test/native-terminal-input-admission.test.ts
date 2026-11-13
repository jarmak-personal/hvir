import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalInputResultCredits } from '../src/shared/native-terminal-input-admission'
import {
  NATIVE_INPUT_RESULTS,
  NativeTerminalInputResourceRefused,
  nativeTerminalInputResultCapacity,
} from '../src/shared/native-terminal-input'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'

const oversized = 66 * 1024 * 1024 + 12
describe('native input result ownership', () => {
  it('admits a sole oversized paste without consuming ordinary input or cleanup capacity', () => {
    const credits = new NativeTerminalInputResultCredits()
    const ordinary = credits.reserve(
      NATIVE_INPUT_RESULTS.aggregateBytes - NATIVE_INPUT_RESULTS.cleanupBytes,
    )
    const paste = credits.reserve(oversized, true)
    const cleanup = credits.reserve(NATIVE_INPUT_RESULTS.cleanupBytes, false, true)
    expect(() => credits.reserve(1)).toThrow(NativeTerminalAdmissionError)
    expect(() => credits.reserve(12, true)).toThrow(NativeTerminalAdmissionError)
    ordinary.release()
    const key = credits.reserve(NATIVE_INPUT_RESULTS.ordinaryBytes)
    key.release()
    cleanup.release()
    paste.release()
    credits.reserve(12, true).release()
  })

  it('waits for every owned normal paste before admitting an oversized paste', () => {
    const credits = new NativeTerminalInputResultCredits()
    const first = credits.reserve(20 * 1024 * 1024, true)
    const second = credits.reserve(20 * 1024 * 1024, true)
    expect(() => credits.reserve(oversized, true)).toThrow(NativeTerminalAdmissionError)
    first.release()
    expect(() => credits.reserve(oversized, true)).toThrow(NativeTerminalAdmissionError)
    second.release()
    const large = credits.reserve(oversized, true)
    const normalInput = credits.reserve(NATIVE_INPUT_RESULTS.wheelBytes)
    normalInput.release()
    expect(() => credits.reserve(oversized, true)).toThrow(NativeTerminalAdmissionError)
    large.release()
    credits.reserve(oversized, true).release()
  })

  it('keeps old repeated release from erasing a newer oversized owner', () => {
    const credits = new NativeTerminalInputResultCredits()
    const old = credits.reserve(oversized, true)
    old.release()
    const current = credits.reserve(oversized + 2, true)
    old.release()
    expect(() => credits.reserve(12, true)).toThrow(NativeTerminalAdmissionError)
    current.release()
    credits.reserve(12, true).release()
  })

  it('refuses unchecked arithmetic before taking any ownership', () => {
    const credits = new NativeTerminalInputResultCredits()
    for (const capacity of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => credits.reserve(capacity, true)).toThrow(
        NativeTerminalInputResourceRefused,
      )
    credits.reserve(oversized, true).release()
  })

  it('sizes paste from allocation-free UTF8 measurement without a fixed source ceiling', () => {
    const text = 'é🙂\r\n\ud800'
    const byteLength = vi.fn((value: string) => Buffer.byteLength(value))
    expect(
      nativeTerminalInputResultCapacity({ kind: 'paste', text }, false, byteLength),
    ).toBe(2 * Buffer.byteLength(text) + 12)
    expect(byteLength).toHaveBeenCalledExactlyOnceWith(text)
    const measured = vi.fn(() => 33 * 1024 * 1024)
    expect(
      nativeTerminalInputResultCapacity(
        { kind: 'paste', text: 'fixture' },
        false,
        measured,
      ),
    ).toBe(oversized)
    expect(() =>
      nativeTerminalInputResultCapacity(
        { kind: 'paste', text: 'fixture' },
        false,
        () => Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(NativeTerminalInputResourceRefused)
  })
})
