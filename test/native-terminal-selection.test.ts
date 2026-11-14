import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalSelection } from '../src/renderer/src/terminal/native-terminal-selection'

const viewId = '11111111-1111-4111-8111-111111111111'

function fixture() {
  let view = viewId
  const port = {
    view: () => view,
    perform: vi.fn(() => Promise.resolve({ hasSelection: false, selectionSerial: 0 })),
    readSelection: vi.fn(() =>
      Promise.resolve({ hasSelection: false, selectionSerial: 0 }),
    ),
    cancel: vi.fn(),
  }
  return {
    port,
    selection: new NativeTerminalSelection(port),
    replaceView: () => {
      view = '22222222-2222-4222-8222-222222222222'
    },
  }
}

describe('native selection copy request lifetime', () => {
  it('leaves the clipboard alone and skips continuation when begin found no selection', async () => {
    const f = fixture()
    const write = vi.fn((_text: string) => Promise.resolve())
    await f.selection.copy(write)
    expect(f.port.readSelection).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(viewId, expect.any(String))
  })

  it('cleans up the captured request when the view changed during begin', async () => {
    const f = fixture()
    f.port.perform.mockImplementationOnce(() => {
      f.replaceView()
      return Promise.resolve({ hasSelection: true, selectionSerial: 1 })
    })
    await expect(f.selection.capability.read()).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(f.port.readSelection).not.toHaveBeenCalled()
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(viewId, expect.any(String))
  })

  it('closes the exact request after continuation failure without disabling later queries', async () => {
    const f = fixture()
    f.port.perform.mockResolvedValueOnce({ hasSelection: true, selectionSerial: 1 })
    f.port.readSelection.mockRejectedValueOnce(new Error('continuation transport failed'))
    await expect(f.selection.capability.read()).rejects.toThrow(
      'continuation transport failed',
    )
    expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(viewId, expect.any(String))
    await expect(f.selection.capability.status()).resolves.toEqual({
      hasSelection: false,
    })
  })
})
