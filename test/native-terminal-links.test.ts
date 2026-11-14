// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalLinks } from '../src/renderer/src/terminal/native-terminal-links'
import { NativeTerminalDomInput } from '../src/renderer/src/terminal/native-terminal-dom-input'
import type {
  NativeTerminalInputCompletion,
  NativeTerminalInputOperation,
} from '../src/shared/native-terminal-input'
import type {
  NativeTerminalLinkActivation,
  NativeTerminalLinkCapture,
  NativeTerminalLinkIntent,
} from '../src/shared/native-terminal-link'
import { localPath } from '../src/shared/host-path'
const link: NativeTerminalLinkActivation = {
  kind: 'file',
  target: 'file:///synthetic.ts',
  workspaceRoot: localPath('/synthetic'),
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
function fixture() {
  let view = 'original'
  const port = {
    view: () => view,
    capture: vi.fn<
      (intent: NativeTerminalLinkIntent) => Promise<NativeTerminalLinkCapture>
    >(() => Promise.resolve({ pending: false, link })),
    read: vi.fn<
      (view: string, id: string) => Promise<NativeTerminalLinkActivation | undefined>
    >(() => Promise.resolve(link)),
    cancel: vi.fn<(view: string, requestId: string) => void>(),
    activate: vi.fn(),
    refused: vi.fn(),
  }
  return {
    owner: new NativeTerminalLinks(port),
    port,
    view: (next: string) => {
      view = next
    },
  }
}
describe('native explicit link intent', () => {
  it('holds the real input FIFO through capture ACK, then permits keys and CtrlC while continuation remains unfinished', async () => {
    if (!MouseEvent.prototype.getModifierState)
      Object.defineProperty(MouseEvent.prototype, 'getModifierState', {
        configurable: true,
        value: () => false,
      })
    const f = fixture(),
      root = document.createElement('div')
    document.body.append(root)
    let capture!: (value: NativeTerminalLinkCapture) => void,
      read!: (value: NativeTerminalLinkActivation) => void
    f.port.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          capture = resolve
        }),
    )
    f.port.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          read = resolve
        }),
    )
    const operations: NativeTerminalInputOperation[] = []
    const dom = new NativeTerminalDomInput(root, {
      input: (op) => {
        operations.push(op)
        return Promise.resolve<NativeTerminalInputCompletion>({
          requestedMutation: 1,
          linkCandidate: op.kind === 'pointer',
          captured: false,
        })
      },
      activateLink: (x, y) => f.owner.begin(x, y),
      clipboardPaste: vi.fn(),
      accepted: vi.fn(),
      refused: vi.fn(),
      failed: vi.fn(),
    })
    cleanups.push(() => {
      void dom.dispose()
    })
    dom.setEnabled(true)
    dom.setReady(true)
    root.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 20,
      }),
    )
    await vi.waitFor(() => expect(f.port.capture).toHaveBeenCalledOnce())
    const key = (code: string, key: string, ctrlKey = false) =>
      dom.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code,
          key,
          ctrlKey,
        }),
      )
    key('KeyA', 'a')
    expect(operations.filter((op) => op.kind === 'key')).toHaveLength(0)
    capture({ pending: true })
    await vi.waitFor(() => expect(f.port.read).toHaveBeenCalledOnce())
    key('KeyC', 'c', true)
    await vi.waitFor(() =>
      expect(operations.filter((op) => op.kind === 'key')).toHaveLength(2),
    )
    expect(f.port.activate).not.toHaveBeenCalled()
    read(link)
    await vi.waitFor(() => expect(f.port.activate).toHaveBeenCalledExactlyOnceWith(link))
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(
      'original',
      f.port.capture.mock.calls[0]![0].requestId,
    )
  })
  it('never starts a continuation after revoked begin ACK and cancels only its exact original request', async () => {
    const f = fixture()
    let finish!: (capture: NativeTerminalLinkCapture) => void
    f.port.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const begin = f.owner.begin(1, 2),
      intent = f.port.capture.mock.calls[0]![0]
    f.owner.revoke()
    f.view('replacement')
    finish({ pending: true })
    await begin
    expect(f.port.read).not.toHaveBeenCalled()
    expect(f.port.activate).not.toHaveBeenCalled()
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith('original', intent.requestId)
    expect(f.port.refused).not.toHaveBeenCalled()
  })
  it('refuses a late continuation effect after replacement and preserves independent later requests', async () => {
    const f = fixture()
    let finish!: (link: NativeTerminalLinkActivation) => void
    f.port.capture.mockResolvedValueOnce({ pending: true })
    f.port.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await f.owner.begin(1, 2)
    f.owner.revoke()
    f.view('replacement')
    await f.owner.begin(3, 4)
    finish(link)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.port.activate).toHaveBeenCalledTimes(1)
    expect(f.port.capture.mock.calls[1]![0].viewId).toBe('replacement')
    expect(f.port.cancel.mock.calls.map(([view]) => view)).toEqual([
      'original',
      'replacement',
    ])
  })
  it('reports a link read failure as an operation refusal rather than an unhandled input failure', async () => {
    const f = fixture()
    f.port.capture.mockResolvedValueOnce({ pending: true })
    f.port.read.mockRejectedValueOnce(new Error('stale'))
    await f.owner.begin(1, 2)
    await vi.waitFor(() => expect(f.port.refused).toHaveBeenCalledOnce())
    await f.owner.begin(3, 4)
    expect(f.port.activate).toHaveBeenCalledExactlyOnceWith(link)
  })
})
