import { describe, expect, it, vi } from 'vitest'

import { createElectronExternalMovePicker } from '../src/main/project-file-operations'

interface OpenDialogOptions {
  readonly title: string
  readonly buttonLabel: string
  readonly properties: Array<
    'openFile' | 'openDirectory' | 'multiSelections' | 'noResolveAliases'
  >
}

describe('Electron external move picker', () => {
  it('uses one mixed multi-selection dialog on macOS without resolving aliases', async () => {
    const showOpenDialog = vi.fn((_options: OpenDialogOptions) =>
      Promise.resolve({ canceled: false, filePaths: ['/outside/a', '/outside/b'] }),
    )
    const picker = createElectronExternalMovePicker({ showOpenDialog }, 'darwin')

    expect(picker.policy).toMatchObject({ kind: 'mixed-multiple' })
    await expect(picker.pick('mixed')).resolves.toEqual(['/outside/a', '/outside/b'])
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases'],
      }),
    )
    await expect(picker.pick('files')).rejects.toThrow('unavailable')
  })

  it('discloses and enforces separate multi-file or single-folder selection on Linux', async () => {
    const showOpenDialog = vi
      .fn((_options: OpenDialogOptions) =>
        Promise.resolve({ canceled: false, filePaths: ['/outside/a'] }),
      )
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/outside/a'] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/outside/folder'] })
    const picker = createElectronExternalMovePicker({ showOpenDialog }, 'linux')

    expect(picker.policy.kind).toBe('files-or-single-directory')
    expect(picker.policy.limitation).toContain('cannot be mixed')
    await picker.pick('files')
    await picker.pick('directory')
    expect(showOpenDialog.mock.calls.map(([options]) => options.properties)).toEqual([
      ['openFile', 'multiSelections'],
      ['openDirectory'],
    ])
    await expect(picker.pick('mixed')).rejects.toThrow('unavailable')
  })

  it('returns cancellation without exposing native paths', async () => {
    const picker = createElectronExternalMovePicker(
      {
        showOpenDialog: () =>
          Promise.resolve({ canceled: true, filePaths: ['/must/not/escape'] }),
      },
      'linux',
    )

    await expect(picker.pick('files')).resolves.toBeUndefined()
  })
})
