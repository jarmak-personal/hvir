// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalDomInput } from '../src/renderer/src/terminal/native-terminal-dom-input'
import type {
  NativeTerminalInputCompletion,
  NativeTerminalInputOperation,
} from '../src/shared/native-terminal-input'
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
function fixture(left = 0) {
  if (!MouseEvent.prototype.getModifierState)
    Object.defineProperty(MouseEvent.prototype, 'getModifierState', {
      configurable: true,
      value: () => false,
    })
  const root = document.createElement('div')
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, 0, 200, 100))
  const setCapture = vi.fn(),
    releaseCapture = vi.fn()
  root.setPointerCapture = setCapture
  root.releasePointerCapture = releaseCapture
  root.hasPointerCapture = vi.fn(() => true)
  const port = {
    input: vi.fn<
      (op: NativeTerminalInputOperation) => Promise<NativeTerminalInputCompletion>
    >(() => Promise.resolve({ requestedMutation: 1, selectionResult: 0 })),
    clipboardPaste: vi.fn(),
    accepted: vi.fn(),
    failed: vi.fn(),
    refused: vi.fn(),
  }
  const input = new NativeTerminalDomInput(root, port)
  input.setEnabled(true)
  input.setReady(true)
  input.setReadonly()
  cleanups.push(() => {
    void input.dispose()
  })
  return {
    root,
    setCapture,
    releaseCapture,
    port,
    input,
    ops: () => port.input.mock.calls.map(([op]) => op),
  }
}
function pointer(target: HTMLElement, type: string, id = 7, x = 10) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: id,
      button: 0,
      clientX: x,
      clientY: 10,
    }),
  )
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function holdPress(f: ReturnType<typeof fixture>) {
  let finish!: (value: NativeTerminalInputCompletion) => void
  f.port.input.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  return (
    value: NativeTerminalInputCompletion = { requestedMutation: 1, selectionResult: 0 },
  ) => finish(value)
}
describe('native pointer source delivery', () => {
  it('routes pending-ACK outside move/up only into the original pane FIFO and leaves other pointer IDs untouched', async () => {
    const a = fixture(),
      b = fixture(200),
      finish = holdPress(a)
    pointer(a.root, 'pointerdown')
    pointer(b.root, 'pointermove', 8, 240)
    await settle()
    expect(b.ops()).toContainEqual(expect.objectContaining({ kind: 'pointer', x: 40 }))
    b.port.input.mockClear()
    pointer(b.root, 'pointermove', 7, 240)
    pointer(b.root, 'pointerup', 7, 250)
    expect(a.setCapture).not.toHaveBeenCalled()
    expect(b.ops()).toEqual([])
    finish()
    await settle()
    expect(a.ops().filter((op) => op.kind === 'pointer')).toEqual([
      expect.objectContaining({ action: 1, x: 10 }),
      expect.objectContaining({ x: 240 }),
      expect.objectContaining({ action: 0, x: 250 }),
    ])
    expect(a.setCapture).not.toHaveBeenCalled()
    pointer(b.root, 'pointermove', 7, 260)
    await settle()
    expect(b.ops()).toContainEqual(expect.objectContaining({ kind: 'pointer', x: 60 }))
  })
  it('delivers same-source events once and authorizes local selection capture only after the native ACK', async () => {
    const a = fixture(),
      finish = holdPress(a)
    pointer(a.root, 'pointerdown')
    pointer(a.root, 'pointermove', 7, 20)
    expect(a.setCapture).not.toHaveBeenCalled()
    finish()
    await settle()
    expect(a.setCapture).toHaveBeenCalledExactlyOnceWith(7)
    expect(a.ops().filter((op) => op.kind === 'pointer')).toHaveLength(2)
    pointer(a.root, 'pointerup')
    await settle()
    expect(a.ops().filter((op) => op.kind === 'pointer')).toHaveLength(3)
    expect(a.releaseCapture).toHaveBeenCalledExactlyOnceWith(7)
  })
  it.each(['hidden', 'dispose'] as const)(
    'revokes the outside route on %s before a late ACK and dispatches readonly cleanup while geometry is unready',
    async (action) => {
      const a = fixture(),
        b = fixture(200),
        finish = holdPress(a)
      pointer(a.root, 'pointerdown')
      a.input.setReady(false)
      const disposed = action === 'dispose' ? a.input.dispose() : undefined
      if (action === 'hidden') a.input.setEnabled(false)
      pointer(b.root, 'pointerup', 7, 240)
      finish()
      await settle()
      await disposed
      expect(a.setCapture).not.toHaveBeenCalled()
      expect(a.ops()).toContainEqual({ kind: 'focus', focused: false })
      expect(b.ops()).toContainEqual(
        expect.objectContaining({ kind: 'pointer', action: 0 }),
      )
      expect(a.port.failed).not.toHaveBeenCalled()
    },
  )
  it('cleans a readonly gesture on real focusout even though no native focus gain was sent', async () => {
    const a = fixture(),
      outside = document.createElement('button')
    document.body.append(outside)
    pointer(a.root, 'pointerdown')
    await settle()
    expect(a.ops()).not.toContainEqual({ kind: 'focus', focused: true })
    a.input.setReady(false)
    outside.focus()
    await settle()
    expect(a.ops()).toContainEqual({ kind: 'focus', focused: false })
    expect(a.releaseCapture).toHaveBeenCalledWith(7)
  })
  it('ignores another pointer inside the source root until the owned gesture ends', async () => {
    const a = fixture(),
      finish = holdPress(a)
    pointer(a.root, 'pointerdown', 7)
    pointer(a.root, 'pointermove', 9, 50)
    pointer(a.root, 'pointerup', 9, 50)
    pointer(a.root, 'pointerdown', 9, 50)
    expect(a.releaseCapture).not.toHaveBeenCalled()
    pointer(a.root, 'pointerup', 7)
    finish()
    await settle()
    expect(a.ops().filter((op) => op.kind === 'pointer')).toEqual([
      expect.objectContaining({ action: 1, x: 10 }),
      expect.objectContaining({ action: 0, x: 10 }),
    ])
    expect(a.setCapture).not.toHaveBeenCalled()
  })
  it('does not let an old ACK capture a newer transaction reusing the same pointer ID', async () => {
    const a = fixture(),
      finish = holdPress(a)
    pointer(a.root, 'pointerdown')
    pointer(a.root, 'pointerup')
    pointer(a.root, 'pointerdown')
    finish()
    await settle()
    expect(a.setCapture).toHaveBeenCalledTimes(1)
    expect(a.ops().filter((op) => op.kind === 'pointer' && op.action === 1)).toHaveLength(
      2,
    )
  })
})
