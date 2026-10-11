import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { createElectronPackagePicker } from '../src/main/extensions/electron-package-picker'
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))
const owner = { id: 100, generation: 1 }

describe('native single Add extension selection', () => {
  it('uses macOS mixed native selection without multiple selection or resolving author aliases', async () => {
    const show = vi.fn(() =>
      Promise.resolve({ canceled: false, filePaths: ['/owned/package'] }),
    )
    expect(await createElectronPackagePicker(show, 'darwin').pick(owner)).toEqual(
      localPath('/owned/package'),
    )
    expect(show).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        properties: ['openFile', 'openDirectory', 'noResolveAliases'],
      }),
    )
  })
  it('maps only the exact Linux manifest to its directory, with a usable file filter and actionable title', async () => {
    const show = vi.fn(() =>
      Promise.resolve({
        canceled: false,
        filePaths: ['/owned/package/hvir-extension.json'],
      }),
    )
    expect(await createElectronPackagePicker(show, 'linux').pick(owner)).toEqual(
      localPath('/owned/package'),
    )
    expect(show).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        properties: ['openFile'],
        title: 'Add extension ZIP or hvir-extension.json',
        filters: [
          { name: 'Extension ZIP or package manifest', extensions: ['zip', 'json'] },
        ],
      }),
    )
  })
  it.each(['linux', 'darwin'] as const)('accepts one ZIP on %s', async (platform) => {
    const show = vi.fn(() =>
      Promise.resolve({ canceled: false, filePaths: ['/owned/package.ZIP'] }),
    )
    expect(await createElectronPackagePicker(show, platform).pick(owner)).toEqual(
      localPath('/owned/package.ZIP'),
    )
  })
  it('refuses unrelated Linux JSON with the achievable folder gesture', async () => {
    await expect(
      createElectronPackagePicker(
        () => Promise.resolve({ canceled: false, filePaths: ['/owned/config.json'] }),
        'linux',
      ).pick(owner),
    ).rejects.toThrow('hvir-extension.json inside')
  })
  it('treats native cancellation as no selection, never using a supplied path', async () => {
    expect(
      await createElectronPackagePicker(() =>
        Promise.resolve({ canceled: true, filePaths: ['/ignored/package.zip'] }),
      ).pick(owner),
    ).toBeUndefined()
  })
  it.each(
    [[], ['/one.zip', '/two.zip'], ['relative.zip'], ['/bad\0.zip']].map((paths) => ({
      paths,
    })),
  )('refuses invalid native selection %j', async ({ paths }) => {
    await expect(
      createElectronPackagePicker(() =>
        Promise.resolve({ canceled: false, filePaths: paths }),
      ).pick(owner),
    ).rejects.toThrow('Select one local')
  })
})
