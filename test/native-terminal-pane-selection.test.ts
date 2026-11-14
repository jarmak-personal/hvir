// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalDomInput } from '../src/renderer/src/terminal/native-terminal-dom-input'
import type { NativeTerminalInputOperation } from '../src/shared/native-terminal-input'
import { NativeTerminalSelection } from '../src/renderer/src/terminal/native-terminal-selection'
import type { NativeTerminalSelectionResponse } from '../src/shared/native-terminal-selection'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
  document.body.replaceChildren()
})

function fixture() {
  let view: string | undefined = 'original-view'
  const port = {
    view: () => view,
    perform: vi.fn<
      (
        action: string,
        requestId: string | undefined,
        signal: AbortSignal,
      ) => Promise<NativeTerminalSelectionResponse>
    >(() => Promise.resolve({ hasSelection: true, selectionSerial: 7 })),
    readSelection: vi.fn<
      (
        viewId: string,
        requestId: string,
        signal: AbortSignal,
      ) => Promise<NativeTerminalSelectionResponse>
    >(() =>
      Promise.resolve({ hasSelection: true, selectionSerial: 7, text: 'exact\ntext' }),
    ),
    cancel: vi.fn(),
  }
  const owner = new NativeTerminalSelection(port)
  return {
    owner,
    port,
    setView: (next: string | undefined) => {
      view = next
    },
  }
}
describe('native pane selection capability', () => {
  it('holds the real DOM FIFO until native begin ACK, then permits keys, CtrlC and cleanup during the unfinished read', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    let begin!: (value: NativeTerminalSelectionResponse) => void,
      finish!: (value: NativeTerminalSelectionResponse) => void
    const operations: NativeTerminalInputOperation[] = []
    const continuation = vi.fn(
      () =>
        new Promise<NativeTerminalSelectionResponse>((resolve) => {
          finish = resolve
        }),
    )
    const dom = new NativeTerminalDomInput(root, {
      input: (op) => {
        operations.push(op)
        return Promise.resolve({ requestedMutation: 1 })
      },
      selection: () =>
        new Promise((resolve) => {
          begin = resolve
        }),
      clipboardPaste: vi.fn(),
      accepted: vi.fn(),
      failed: vi.fn(),
      refused: vi.fn(),
    })
    cleanups.push(() => {
      void dom.dispose()
    })
    dom.setEnabled(true)
    dom.setReady(true)
    dom.focus()
    await vi.waitFor(() =>
      expect(operations).toContainEqual({ kind: 'focus', focused: true }),
    )
    operations.length = 0
    const owner = new NativeTerminalSelection({
      view: () => 'view',
      perform: (action, id, signal) => dom.selection(action, id, signal),
      readSelection: continuation,
      cancel: vi.fn(),
    })
    const reading = owner.capability.read()
    const key = (code: string, key: string, extra: KeyboardEventInit = {}) =>
      dom.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code,
          key,
          ...extra,
        }),
      )
    key('KeyA', 'a')
    await Promise.resolve()
    expect(operations).toEqual([])
    expect(continuation).not.toHaveBeenCalled()
    begin({ hasSelection: true, selectionSerial: 1 })
    await vi.waitFor(() => expect(continuation).toHaveBeenCalledOnce())
    expect(operations).toContainEqual(expect.objectContaining({ kind: 'key', text: 'a' }))
    key('KeyC', 'c', { ctrlKey: true })
    await vi.waitFor(() =>
      expect(operations.filter((op) => op.kind === 'key')).toHaveLength(2),
    )
    dom.setEnabled(false)
    await vi.waitFor(() =>
      expect(operations).toContainEqual({ kind: 'focus', focused: false }),
    )
    finish({ hasSelection: true, selectionSerial: 1, text: 'copied' })
    await expect(reading).resolves.toBe('copied')
  })
  it('cancels the same request during continuation and rejects its successful late bytes before clipboard commit', async () => {
    const f = fixture(),
      write = vi.fn(() => Promise.resolve())
    let finish!: (value: NativeTerminalSelectionResponse) => void
    f.port.readSelection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const copying = f.owner.copy(write),
      rejected = expect(copying).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.port.readSelection).toHaveBeenCalledOnce())
    const [view, id, signal] = f.port.readSelection.mock.calls[0]!
    expect(id).toBe(f.port.perform.mock.calls[0]![1])
    f.owner.revoke()
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(view, id)
    expect(signal.aborted).toBe(true)
    finish({ hasSelection: true, selectionSerial: 1, text: 'late' })
    await rejected
    expect(write).not.toHaveBeenCalled()
  })
  it('reads afresh and rejects a captured capability after hide and return to the same view', async () => {
    const f = fixture(),
      original = f.owner.capability
    await expect(original.read()).resolves.toBe('exact\ntext')
    f.port.readSelection.mockResolvedValueOnce({
      hasSelection: true,
      selectionSerial: 8,
      text: 'new',
    })
    await expect(original.read()).resolves.toBe('new')
    expect(f.port.perform).toHaveBeenCalledTimes(2)
    f.owner.revoke()
    expect(f.owner.capability).not.toBe(original)
    await expect(original.read()).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.port.perform).toHaveBeenCalledTimes(2)
  })
  it('cancels only the captured view and request, refusing stale completed extraction before clipboard commit', async () => {
    const f = fixture(),
      write = vi.fn(() => Promise.resolve())
    let finish!: (value: NativeTerminalSelectionResponse) => void
    f.port.perform.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const copying = f.owner.copy(write),
      rejected = expect(copying).rejects.toMatchObject({ name: 'AbortError' })
    const [, requestId, signal] = f.port.perform.mock.calls[0]!
    expect(requestId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    )
    f.setView('replacement-view')
    f.owner.revoke()
    expect(signal.aborted).toBe(true)
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith('original-view', requestId)
    finish({ hasSelection: true, selectionSerial: 7, text: 'old' })
    await rejected
    expect(f.port.readSelection).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
  it('sends explicit request cancellation on caller abort without caching a successful late result', async () => {
    const f = fixture(),
      abort = new AbortController()
    let finish!: (value: NativeTerminalSelectionResponse) => void
    f.port.perform.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const reading = f.owner.capability.read(abort.signal),
      rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    expect(f.port.cancel).toHaveBeenCalledOnce()
    finish({ hasSelection: true, selectionSerial: 7, text: 'old' })
    await rejected
    await expect(f.owner.capability.read()).resolves.toBe('exact\ntext')
    expect(f.port.perform).toHaveBeenCalledTimes(2)
  })
})
