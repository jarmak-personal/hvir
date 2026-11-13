import { describe, expect, it } from 'vitest'
import { nativeTerminalKeyOperation, validNativeTerminalInput, validNativeTerminalInputResult } from '../src/shared/native-terminal-input'

describe('closed native input operation and completion contracts', () => {
  it.each(['toString', 'constructor', '__proto__', 'prototype', '', null, undefined])('refuses unknown kind %s without throwing', (kind) => {
    expect(validNativeTerminalInput({ kind })).toBe(false)
  })
  it.each([null, false, 0, '', [], {}, { x: 1, y: 2, width: 3, height: 4 }])('refuses malformed caret metadata %s without throwing', (caret) => {
    expect(validNativeTerminalInputResult({ bytes: new Uint8Array(), capacity: 0,
      source: 'user', requestedMutation: 1, caret })).toBe(false)
  })
  it('keeps native button IDs unchanged and rejects renderer-selected private flags', () => {
    for (const button of [1, 2, 3, 11]) expect(validNativeTerminalInput({ kind: 'pointer', x: 2, y: 3, modifiers: 0, button, action: 1 })).toBe(true)
    for (const button of [0, 12]) expect(validNativeTerminalInput({ kind: 'pointer', x: 2, y: 3, modifiers: 0, button, action: 1 })).toBe(false)
    expect(validNativeTerminalInput({ kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 1,
      modifiers: 0, precision: true, readOnly: true })).toBe(false)
  })
  it('rebuilds the compatibility preview key into the closed richer operation', () => {
    const key = nativeTerminalKeyOperation({ key: 58, modifiers: 2, action: 1, text: '' })
    expect(validNativeTerminalInput(key)).toBe(true)
    expect(validNativeTerminalInput({ ...key, keyEncodingFallback: 'csi-u' })).toBe(false)
    expect(validNativeTerminalInput({ ...key, unshiftedCodepoint: 0xd800 })).toBe(false)
  })
})
