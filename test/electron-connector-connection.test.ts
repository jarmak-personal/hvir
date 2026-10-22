import { describe, expect, it, vi } from 'vitest'
import { createElectronConnectorConnection } from '../src/main/extensions/electron-connector-connection'

const native = vi.hoisted(() => ({
  window: { webContents: { id: 42 }, isDestroyed: () => false },
  showOpenDialog: vi.fn(),
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [native.window] },
  dialog: native,
}))

describe('parented native program connection edge', () => {
  it('keeps manual file selection single, local and truthful on cancellation or invalid choice', async () => {
    const dialog = createElectronConnectorConnection(undefined, [])
    native.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await dialog.choose({ id: 42, generation: 1 }, 'tool', [])).toBeUndefined()
    native.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['relative/tool'],
    })
    await expect(dialog.choose({ id: 42, generation: 1 }, 'tool', [])).rejects.toThrow(
      'local executable',
    )
    native.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/installed/tool'],
    })
    expect(
      await dialog.choose({ id: 42, generation: 1 }, 'tool', [
        '/installed/tool',
        '/other/tool',
      ]),
    ).toBe('/installed/tool')
    expect(native.showOpenDialog).toHaveBeenLastCalledWith(
      native.window,
      expect.objectContaining({
        properties: ['openFile'],
        defaultPath: '/installed/tool',
      }),
    )
  })
})
