import { describe, expect, it } from 'vitest'
import {
  validNativeTerminalSelectionRequest,
  validNativeTerminalSelectionCancellation,
  validNativeTerminalSelectionResponse,
  validNativeTerminalSelectionState,
} from '../src/shared/native-terminal-selection'

const viewId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

describe('native selection wire contract', () => {
  it('requires a cancellable request identity for exact copy', () => {
    expect(validNativeTerminalSelectionRequest({ viewId, action: 'copy' })).toBe(false)
    expect(
      validNativeTerminalSelectionRequest({ viewId, action: 'copy', requestId }),
    ).toBe(true)
    expect(validNativeTerminalSelectionCancellation({ viewId, requestId })).toBe(true)
    expect(validNativeTerminalSelectionCancellation({ viewId })).toBe(false)
    expect(
      validNativeTerminalSelectionCancellation({ viewId, requestId, instanceId: viewId }),
    ).toBe(false)
    expect(validNativeTerminalSelectionRequest({ viewId, action: 'state' })).toBe(true)
    expect(
      validNativeTerminalSelectionRequest({ viewId: '-'.repeat(36), action: 'state' }),
    ).toBe(false)
  })

  it('accepts intent without renderer-selected native or clipboard authority', () => {
    const request = { viewId, action: 'select-all' }
    expect(validNativeTerminalSelectionRequest(request)).toBe(true)
    for (const extra of [
      { instanceId: requestId },
      { readOnly: false },
      { nativeState: requestId },
      { clipboard: 'selection' },
    ])
      expect(validNativeTerminalSelectionRequest({ ...request, ...extra })).toBe(false)
    for (const action of ['toString', 'constructor', 'paste', null])
      expect(validNativeTerminalSelectionRequest({ viewId, action })).toBe(false)
  })

  it('validates selection identity without imposing an OSC52 text limit', () => {
    const text = 'x'.repeat(65536) + '\n日本語'
    expect(
      validNativeTerminalSelectionResponse({
        hasSelection: true,
        selectionSerial: 1,
        text,
      }),
    ).toBe(true)
    expect(
      validNativeTerminalSelectionResponse({ hasSelection: false, selectionSerial: 0 }),
    ).toBe(true)
    for (const selectionSerial of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(
        validNativeTerminalSelectionResponse({ hasSelection: true, selectionSerial }),
      ).toBe(false)
    expect(validNativeTerminalSelectionResponse(null)).toBe(false)
    const state = { hasSelection: true, selectionSerial: 1 }
    expect(validNativeTerminalSelectionState(state)).toBe(true)
    expect(validNativeTerminalSelectionState({ ...state, text: 'not state' })).toBe(false)
    expect(validNativeTerminalSelectionResponse({ ...state, clipboard: true })).toBe(
      false,
    )
    expect(
      validNativeTerminalSelectionResponse({
        hasSelection: true,
        selectionSerial: 1,
        text: new Uint8Array(),
      }),
    ).toBe(false)
  })
})
