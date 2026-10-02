import { userInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const showOpenDialog = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showOpenDialog } }))
import { createElectronSshConfiguration } from '../src/main/project-host/electron-ssh-configuration'
import { localPath } from '../src/shared/host-path'

const catalog = {
  refreshHosts: () => Promise.resolve([]),
  addSshHost: () => Promise.resolve([]),
}

describe('native SSH configuration adapter', () => {
  it('uses the local account default and returns a host-qualified file from a bounded native picker', async () => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/keys/selected'],
    })
    const adapter = createElectronSshConfiguration(catalog)
    expect(adapter.defaults()).toEqual({ username: userInfo().username, port: 22 })
    await expect(adapter.pickIdentity(() => undefined)).resolves.toEqual(
      localPath('/keys/selected'),
    )
    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose SSH identity file',
      buttonLabel: 'Use identity file',
      properties: ['openFile', 'showHiddenFiles'],
    })
  })

  it('leaves identity selection unset on cancellation and rejects a late revoked selection', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const adapter = createElectronSshConfiguration(catalog)
    await expect(adapter.pickIdentity(() => undefined)).resolves.toBeUndefined()
    let active = true
    showOpenDialog.mockImplementationOnce(() => {
      active = false
      return Promise.resolve({ canceled: false, filePaths: ['/keys/late'] })
    })
    await expect(
      adapter.pickIdentity(() => {
        if (!active) throw new Error('Renderer revoked')
      }),
    ).rejects.toThrow('Renderer revoked')
  })
})
