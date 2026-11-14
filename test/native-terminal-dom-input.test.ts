// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalDomInput } from '../src/renderer/src/terminal/native-terminal-dom-input'
import { nativeTerminalPhysicalKey } from '../src/renderer/src/terminal/native-terminal-key-map'
import type {
  NativeTerminalInputCompletion,
  NativeTerminalInputOperation,
} from '../src/shared/native-terminal-input'

const cleanups: (() => void)[] = []
function fixture() {
  if (!MouseEvent.prototype.getModifierState)
    Object.defineProperty(MouseEvent.prototype, 'getModifierState', {
      configurable: true,
      value: () => false,
    })
  if (!WheelEvent.prototype.getModifierState)
    Object.defineProperty(WheelEvent.prototype, 'getModifierState', {
      configurable: true,
      value: () => false,
    })
  const root = document.createElement('div')
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 640, 400))
  const port = {
    input: vi.fn<
      (op: NativeTerminalInputOperation) => Promise<NativeTerminalInputCompletion>
    >(() => Promise.resolve({ requestedMutation: 1 })),
    clipboardPaste: vi.fn(),
    accepted: vi.fn(),
    failed: vi.fn(),
    refused: vi.fn(),
  }
  const input = new NativeTerminalDomInput(root, port)
  input.setEnabled(true)
  input.setReady(true)
  const text = input.textarea
  const key = (
    type: string,
    code: string,
    value: string,
    extra: KeyboardEventInit = {},
  ) => {
    const event = new KeyboardEvent(type, {
      code,
      key: value,
      bubbles: true,
      cancelable: true,
      ...extra,
    })
    vi.spyOn(event, 'getModifierState').mockImplementation(() => false)
    text.dispatchEvent(event)
    return event
  }
  const before = (data: string, inputType = 'insertText') =>
    text.dispatchEvent(
      new InputEvent('beforeinput', { data, inputType, bubbles: true, cancelable: true }),
    )
  const composition = (type: string, data = '') => {
    const event = new CompositionEvent(type, { bubbles: true })
    Object.defineProperty(event, 'data', { value: data })
    return text.dispatchEvent(event)
  }
  const ops = () => port.input.mock.calls.map(([op]) => op)
  const settle = async () => {
    for (let n = 0; n < 120; n++) await Promise.resolve()
  }
  cleanups.push(() => {
    void input.dispose()
    root.remove()
  })
  return { root, port, input, text, key, before, composition, ops, settle }
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native browser input transactions', () => {
  it('uses the pinned full physical key table, including international, keypad, media and F25 keys', () => {
    expect(nativeTerminalPhysicalKey('KeyA')).toBe(20)
    expect(nativeTerminalPhysicalKey('KeyZ')).toBe(45)
    expect(nativeTerminalPhysicalKey('Enter')).toBe(58)
    expect(nativeTerminalPhysicalKey('IntlYen')).toBe(19)
    expect(nativeTerminalPhysicalKey('NumpadEnter')).toBe(97)
    expect(nativeTerminalPhysicalKey('F25')).toBe(145)
    expect(nativeTerminalPhysicalKey('AudioVolumeUp')).toBe(171)
    expect(nativeTerminalPhysicalKey('unknown')).toBe(0)
  })
  it('sends press/repeat/release once and suppresses the matching browser text insertion', async () => {
    const f = fixture()
    f.key('keydown', 'KeyA', 'a')
    f.before('a')
    f.key('keydown', 'KeyA', 'a', { repeat: true })
    f.key('keyup', 'KeyA', 'a')
    await f.settle()
    expect(
      f
        .ops()
        .filter((op) => op.kind === 'key')
        .map((op) => op.action),
    ).toEqual([1, 2, 0])
    expect(f.port.accepted.mock.calls).toEqual([['a'], ['a']])
  })
  it('preserves AltGr text, consumed modifiers, layout-independent physical code and Unicode', async () => {
    const f = fixture()
    const event = new KeyboardEvent('keydown', {
      code: 'KeyQ',
      key: '@',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    vi.spyOn(event, 'getModifierState').mockImplementation((key) => key === 'AltGraph')
    f.text.dispatchEvent(event)
    f.before('🙂')
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([
      expect.objectContaining({
        key: 36,
        text: '@',
        modifiers: 6,
        consumedModifiers: 6,
        unshiftedCodepoint: 0,
      }),
      expect.objectContaining({ key: 0, text: '🙂' }),
    ])
  })
  it('keeps native preedit separate from one committed IME body and its duplicate beforeinput', async () => {
    const f = fixture()
    f.composition('compositionstart')
    f.key('keydown', 'KeyA', 'Process', { isComposing: true })
    f.composition('compositionupdate', 'に')
    f.before('に', 'insertCompositionText')
    f.composition('compositionend', '日本')
    f.before('日本', 'insertFromComposition')
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'preedit')).toEqual([
      { kind: 'preedit', text: '' },
      { kind: 'preedit', text: 'に' },
      { kind: 'preedit', text: null },
    ])
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([
      expect.objectContaining({ text: '日本', key: 0 }),
    ])
    expect(f.text.value).toBe('')
  })
  it('lets dead keys compose through browser input and emits no raw dead key', async () => {
    const f = fixture()
    expect(f.key('keydown', 'Quote', 'Dead').defaultPrevented).toBe(false)
    expect(f.key('keydown', 'KeyE', 'e').defaultPrevented).toBe(false)
    f.before('é')
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([
      expect.objectContaining({ text: 'é', key: 0 }),
    ])
  })
  it('does not consume a reserved workbench shortcut', async () => {
    const f = fixture()
    f.root.addEventListener('keydown', (event) => event.preventDefault(), {
      capture: true,
    })
    f.key('keydown', 'KeyP', 'p', { metaKey: true })
    await f.settle()
    expect(f.port.input).not.toHaveBeenCalled()
  })
  it('keeps exact Ctrl-V/Ctrl-Alt-V image fallback and suppresses a duplicate browser paste', async () => {
    const f = fixture()
    f.key('keydown', 'KeyV', 'v', { ctrlKey: true })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'duplicate' },
    })
    f.text.dispatchEvent(paste)
    f.key('keydown', 'KeyV', 'v', { ctrlKey: true, altKey: true })
    await f.settle()
    expect(f.port.clipboardPaste.mock.calls).toEqual([['\x16'], ['\x1b\x16']])
    expect(f.ops().filter((op) => op.kind === 'paste' || op.kind === 'key')).toEqual([])
  })
  it('passes a complete ordinary text paste above 64KiB without truncation or splitting', async () => {
    const f = fixture()
    const text = '🙂\r\n'.repeat(20000)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text } })
    f.text.dispatchEvent(paste)
    await f.settle()
    expect(f.ops()).toEqual([{ kind: 'paste', text }])
    expect(paste.defaultPrevented).toBe(true)
  })
  it('places the real textarea using native CSS caret coordinates without a second DPR transform', async () => {
    const f = fixture()
    f.port.input.mockResolvedValue({
      requestedMutation: 1,
      caret: { x: 123, y: 42, width: 8, height: 19, geometrySerial: 1 },
    })
    f.input.focus()
    await f.settle()
    expect(document.activeElement).toBe(f.text)
    expect(f.text.style.left).toBe('123px')
    expect(f.text.style.top).toBe('42px')
    expect(f.text.style.height).toBe('19px')
  })
  it('revokes queued input and composition immediately, keeping cleanup after the physical old call', async () => {
    const f = fixture()
    let resolve!: (value: NativeTerminalInputCompletion) => void
    f.port.input.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.input.focus()
    f.composition('compositionstart')
    f.key('keydown', 'KeyA', 'Process', { isComposing: true })
    f.input.setEnabled(false)
    f.composition('compositionend', 'stale')
    resolve({
      requestedMutation: 1,
      caret: { x: 900, y: 900, width: 1, height: 1, geometrySerial: 1 },
    })
    await f.settle()
    expect(f.ops()).toEqual([
      { kind: 'focus', focused: true },
      { kind: 'preedit', text: null },
      { kind: 'focus', focused: false },
    ])
    expect(f.text.style.left).toBe('0px')
    expect(f.port.accepted).not.toHaveBeenCalled()
  })
  it('normalizes line/page wheel values to CSS pixels and keeps DOM direction exactly once', async () => {
    const f = fixture()
    f.text.style.lineHeight = '20px'
    const line = new WheelEvent('wheel', {
      deltaMode: 1,
      deltaX: -2,
      deltaY: 3,
      cancelable: true,
    })
    Object.defineProperties(line, { clientX: { value: 30 }, clientY: { value: 60 } })
    f.root.dispatchEvent(line)
    const page = new WheelEvent('wheel', { deltaMode: 2, deltaY: 1, cancelable: true })
    Object.defineProperties(page, { clientX: { value: 0 }, clientY: { value: 0 } })
    f.root.dispatchEvent(page)
    await f.settle()
    expect(f.ops()).toEqual([
      expect.objectContaining({
        kind: 'wheel',
        x: 20,
        y: 40,
        deltaX: -40,
        deltaY: 60,
        precision: true,
      }),
      expect.objectContaining({ kind: 'wheel', deltaY: 400 }),
    ])
  })
  it('captures only a native-authorized current pointer and releases it on hide', async () => {
    const f = fixture()
    const setCapture = vi.fn()
    const releaseCapture = vi.fn()
    f.root.setPointerCapture = setCapture
    f.root.hasPointerCapture = vi.fn(() => true)
    f.root.releasePointerCapture = releaseCapture
    f.port.input.mockResolvedValue({ requestedMutation: 1, captured: true })
    f.root.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 7,
        button: 0,
        clientX: 40,
        clientY: 60,
      }),
    )
    await f.settle()
    expect(f.ops()).toContainEqual(
      expect.objectContaining({ kind: 'pointer', x: 30, y: 40, button: 1, action: 1 }),
    )
    expect(setCapture).toHaveBeenCalledWith(7)
    f.input.setEnabled(false)
    expect(releaseCapture).toHaveBeenCalledWith(7)
  })
  it('bounds queued gestures while retaining physical completion, and waits for cleanup at disposal', async () => {
    const f = fixture()
    let resolve!: (value: NativeTerminalInputCompletion) => void
    f.port.input.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.input.focus()
    for (let i = 0; i < 35; i++) f.key('keydown', 'KeyA', 'a')
    expect(f.port.refused).toHaveBeenCalledWith(expect.stringContaining('capacity'))
    const disposing = f.input.dispose()
    resolve({ requestedMutation: 1 })
    await disposing
    expect(f.ops()).toEqual([
      { kind: 'focus', focused: true },
      { kind: 'focus', focused: false },
    ])
    f.key('keydown', 'KeyB', 'b')
    expect(f.port.input).toHaveBeenCalledTimes(2)
  })
  it('retains browser preedit contents until commit instead of resetting the active OS composition', async () => {
    const f = fixture()
    f.composition('compositionstart')
    f.text.value = 'に'
    f.text.dispatchEvent(new InputEvent('input', { data: 'に', isComposing: true }))
    expect(f.text.value).toBe('に')
    f.composition('compositionend', '')
    await f.settle()
    expect(f.text.value).toBe('')
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([])
  })
  it('holds the explicit clipboard gesture until current visible geometry is acknowledged', async () => {
    const f = fixture()
    f.input.setReady(false)
    f.key('keydown', 'KeyV', 'v', { ctrlKey: true })
    expect(f.port.clipboardPaste).not.toHaveBeenCalled()
    f.input.setReady(true)
    await f.settle()
    expect(f.port.clipboardPaste).toHaveBeenCalledExactlyOnceWith('\x16')
  })
  it('does not place a caret returned after a newer geometry update began', async () => {
    const f = fixture()
    let resolve!: (value: NativeTerminalInputCompletion) => void
    f.port.input.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.key('keydown', 'KeyA', 'a')
    f.input.setReady(false)
    resolve({
      requestedMutation: 1,
      caret: { x: 123, y: 456, width: 1, height: 18, geometrySerial: 1 },
    })
    await f.settle()
    expect(f.text.style.left).toBe('0px')
    f.input.setReady(true)
    await f.settle()
    expect(f.port.failed).not.toHaveBeenCalled()
  })
  it('finishes one blur cleanup when disabling the focused text host also emits focusout', async () => {
    const f = fixture()
    let resolve!: (value: NativeTerminalInputCompletion) => void
    f.port.input.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.input.focus()
    f.input.setReady(false)
    f.input.setEnabled(false)
    f.text.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    resolve({ requestedMutation: 1 })
    await f.settle()
    expect(f.ops()).toEqual([
      { kind: 'focus', focused: true },
      { kind: 'focus', focused: false },
    ])
  })
  it('derives non-US character identity from the browser layout, not the physical US key label', async () => {
    const f = fixture()
    f.key('keydown', 'KeyQ', 'a')
    f.key('keydown', 'KeyQ', 'A', { shiftKey: true })
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([
      expect.objectContaining({ key: 36, text: 'a', unshiftedCodepoint: 97 }),
      expect.objectContaining({ key: 36, text: 'A', unshiftedCodepoint: 97 }),
    ])
  })
  it('uses the optional browser layout map for shifted punctuation and refreshes on a layout change', async () => {
    const keyboard = Object.assign(new EventTarget(), {
      onlayoutchange: null,
      getLayoutMap: vi.fn(() => Promise.resolve(new Map([['Digit2', 'é']]))),
    })
    vi.stubGlobal('navigator', { keyboard })
    const f = fixture()
    await f.settle()
    f.key('keydown', 'Digit2', '2', { shiftKey: true })
    keyboard.getLayoutMap.mockResolvedValue(new Map([['Digit2', '2']]))
    keyboard.dispatchEvent(new Event('layoutchange'))
    await f.settle()
    f.key('keydown', 'Digit2', '@', { shiftKey: true })
    f.key('keydown', 'Digit2', 'é')
    f.key('keydown', 'Digit2', '2', { shiftKey: true })
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'key')).toEqual([
      expect.objectContaining({ unshiftedCodepoint: 233 }),
      expect.objectContaining({ unshiftedCodepoint: 50 }),
      expect.objectContaining({ unshiftedCodepoint: 233 }),
      expect.objectContaining({ unshiftedCodepoint: 0 }),
    ])
  })
  it('releases the retained actual button when pointercancel carries button -1', async () => {
    const f = fixture()
    f.root.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 4,
        button: 2,
        clientX: 35,
        clientY: 65,
      }),
    )
    f.root.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 4, button: -1 }))
    await f.settle()
    expect(f.ops().filter((op) => op.kind === 'pointer')).toEqual([
      expect.objectContaining({ button: 2, action: 1, x: 25, y: 45 }),
      expect.objectContaining({ button: 2, action: 0, x: 25, y: 45 }),
    ])
  })
  it('keeps admitted gestures and uses one native reset when release credits are exhausted', async () => {
    const f = fixture()
    let resolve!: (value: NativeTerminalInputCompletion) => void
    f.port.input.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    f.input.focus()
    const codes = Array.from(
      { length: 26 },
      (_, i) => `Key${String.fromCharCode(65 + i)}`,
    ).concat(['Digit1', 'Digit2', 'Digit3'])
    for (const code of codes) f.key('keydown', code, 'a')
    for (const code of codes) f.key('keyup', code, 'a')
    expect(f.port.refused).toHaveBeenCalled()
    resolve({ requestedMutation: 1 })
    await f.settle()
    const keys = f.ops().filter((op) => op.kind === 'key')
    expect(keys.filter((op) => op.action === 1)).toHaveLength(29)
    expect(keys.filter((op) => op.action === 0)).toHaveLength(2)
    expect(f.ops().filter((op) => op.kind === 'focus')).toEqual([
      { kind: 'focus', focused: true },
      { kind: 'focus', focused: false },
      { kind: 'focus', focused: true },
    ])
    expect(f.port.failed).not.toHaveBeenCalled()
    f.key('keydown', 'KeyZ', 'z')
    await f.settle()
    expect(f.ops()).toContainEqual(
      expect.objectContaining({ kind: 'key', text: 'z', action: 1 }),
    )
  })
  it('maps DOM left/middle/right to the native public button IDs exactly once', async () => {
    const f = fixture()
    for (const button of [0, 1, 2]) {
      f.root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button }))
      f.root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, button }))
    }
    await f.settle()
    expect(
      f
        .ops()
        .filter((op) => op.kind === 'pointer')
        .map((op) => [op.button, op.action]),
    ).toEqual([
      [1, 1],
      [1, 0],
      [3, 1],
      [3, 0],
      [2, 1],
      [2, 0],
    ])
  })
  it('retains readonly wheel/position navigation but sends no typing, paste, focus gain or button reports', async () => {
    const f = fixture()
    f.input.setReadonly()
    f.key('keydown', 'KeyA', 'a')
    f.key('keyup', 'KeyA', 'a')
    f.key('keydown', 'KeyV', 'v', { ctrlKey: true })
    f.before('stale')
    f.composition('compositionstart')
    f.composition('compositionend', 'stale')
    const paste = new Event('paste', { bubbles: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'stale' } })
    f.text.dispatchEvent(paste)
    f.input.focus()
    const wheel = new WheelEvent('wheel', { deltaY: 30, cancelable: true })
    Object.defineProperties(wheel, { clientX: { value: 20 }, clientY: { value: 40 } })
    f.root.dispatchEvent(wheel)
    f.root.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 2,
        button: 0,
        clientX: 30,
        clientY: 50,
      }),
    )
    f.root.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: 2,
        button: 0,
        clientX: 30,
        clientY: 50,
      }),
    )
    await f.settle()
    expect(f.ops()).toEqual([
      expect.objectContaining({ kind: 'wheel', deltaY: 30 }),
      { kind: 'pointer', x: 20, y: 30, modifiers: 0 },
    ])
    expect(f.text.disabled).toBe(true)
    expect(f.port.accepted).not.toHaveBeenCalled()
    expect(f.port.clipboardPaste).not.toHaveBeenCalled()
    f.input.setEnabled(false)
    f.root.dispatchEvent(wheel)
    await f.settle()
    expect(f.port.input).toHaveBeenCalledTimes(2)
  })
  it('reports proven-unsent capacity without accepted-input notification, readonly or automatic replay', async () => {
    const f = fixture()
    f.port.input.mockResolvedValueOnce({ requestedMutation: 0, refused: 'capacity' })
    f.key('keydown', 'KeyA', 'a')
    f.key('keydown', 'KeyB', 'b')
    await f.settle()
    expect(
      f
        .ops()
        .filter((op) => op.kind === 'key')
        .map((op) => op.text),
    ).toEqual(['a', 'b'])
    expect(f.port.accepted.mock.calls).toEqual([['b']])
    expect(f.port.refused).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('capacity'),
    )
    expect(f.port.failed).not.toHaveBeenCalled()
    expect(f.text.disabled).toBe(false)
  })
  it.each(['key', 'pointer'] as const)(
    'resets native state after a refused %s release without discarding admitted gestures',
    async (kind) => {
      const f = fixture()
      f.input.focus()
      if (kind === 'key') f.key('keydown', 'KeyA', 'a')
      else
        f.root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, button: 1 }))
      await f.settle()
      f.port.input.mockClear()
      f.port.accepted.mockClear()
      f.port.input.mockResolvedValueOnce({ requestedMutation: 0, refused: 'capacity' })
      if (kind === 'key') f.key('keyup', 'KeyA', 'a')
      else
        f.root.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId: 3, button: -1 }),
        )
      f.key('keydown', 'KeyB', 'b')
      await f.settle()
      expect(f.ops().filter((op) => op.kind === 'focus')).toEqual([
        { kind: 'focus', focused: false },
        { kind: 'focus', focused: true },
      ])
      expect(f.ops().filter((op) => op.kind === 'key' && op.action === 1)).toEqual([
        expect.objectContaining({ text: 'b' }),
      ])
      expect(f.port.accepted.mock.calls).toEqual([['b']])
      expect(f.port.failed).not.toHaveBeenCalled()
      expect(f.port.refused).toHaveBeenCalledTimes(1)
    },
  )
  it('keeps Electron typing safe without trusting a static layout map that has no change signal', async () => {
    const getLayoutMap = vi.fn(() => Promise.resolve(new Map([['Digit2', 'é']])))
    vi.stubGlobal('navigator', { keyboard: { getLayoutMap } })
    const f = fixture()
    await f.settle()
    f.key('keydown', 'Digit2', '2', { shiftKey: true })
    await f.settle()
    expect(f.ops()).toContainEqual(
      expect.objectContaining({ kind: 'key', unshiftedCodepoint: 0 }),
    )
    expect(getLayoutMap).not.toHaveBeenCalled()
    expect(() => f.input.setEnabled(false)).not.toThrow()
    await expect(f.input.dispose()).resolves.toBeUndefined()
  })
  it.each([
    {},
    { getLayoutMap: undefined, addEventListener: 1, removeEventListener: {} },
    Object.assign(new EventTarget(), {
      onlayoutchange: null,
      getLayoutMap: () => {
        throw new Error('unavailable')
      },
    }),
  ])(
    'keeps typing when optional keyboard metadata is unavailable (%j)',
    async (keyboard) => {
      vi.stubGlobal('navigator', { keyboard })
      const f = fixture()
      await f.settle()
      f.key('keydown', 'KeyQ', 'a')
      f.key('keydown', 'Digit2', '@', { shiftKey: true })
      await f.settle()
      expect(
        f
          .ops()
          .filter((op) => op.kind === 'key')
          .map((op) => op.unshiftedCodepoint),
      ).toEqual([97, 0])
      expect(f.port.failed).not.toHaveBeenCalled()
      expect(() => f.input.setEnabled(false)).not.toThrow()
      await expect(f.input.dispose()).resolves.toBeUndefined()
    },
  )
})
