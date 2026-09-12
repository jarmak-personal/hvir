import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { createSkillagerFolderPicker } from '../src/main/skillager/electron-skillager-folder-picker'
import { localPath } from '../src/shared/host-path'

const owner = { id: 7, generation: 1 },
  parent = {} as BrowserWindow
it('selects one existing directory, canonicalizes via ProjectHost, and never enables native creation', async () => {
  const realpath = vi.fn(() => Promise.resolve(localPath('/canonical/library')))
  const showOpenDialog = vi.fn(() =>
    Promise.resolve({ canceled: false, filePaths: ['/chosen/library'] }),
  )
  const picker = createSkillagerFolderPicker(
    { realpath },
    { showOpenDialog },
    () => parent,
  )
  expect(
    await picker.choose(
      owner,
      localPath('/default/library'),
      new AbortController().signal,
    ),
  ).toEqual(localPath('/canonical/library'))
  expect(showOpenDialog).toHaveBeenCalledWith(
    parent,
    expect.objectContaining({
      defaultPath: '/default/library',
      properties: ['openDirectory'],
    }),
  )
  expect(realpath).toHaveBeenCalledWith(localPath('/chosen/library'))
  showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  expect(
    await picker.choose(
      owner,
      localPath('/canonical/library'),
      new AbortController().signal,
    ),
  ).toBeUndefined()
  expect(realpath).toHaveBeenCalledOnce()
})

it.each(['resolve', 'reject'] as const)(
  'settles cancellation without native completion, admits no duplicate dialog, then releases on %s',
  async (outcome) => {
    let complete!: (value: { canceled: boolean; filePaths: string[] }) => void,
      fail!: (reason: unknown) => void
    const showOpenDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((resolve, reject) => {
          complete = resolve
          fail = reject
        }),
    )
    const realpath = vi.fn(() => Promise.resolve(localPath('/must-not-read')))
    const picker = createSkillagerFolderPicker(
      { realpath },
      { showOpenDialog },
      () => parent,
    )
    const controller = new AbortController(),
      root = localPath('/default/library')
    const chosen = picker.choose(owner, root, controller.signal)
    controller.abort()
    await expect(chosen).rejects.toMatchObject({ reason: 'cancelled' })
    await expect(
      picker.choose(owner, root, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'busy' })
    expect(showOpenDialog).toHaveBeenCalledOnce()
    if (outcome === 'resolve') complete({ canceled: false, filePaths: ['/late'] })
    else fail(Error('PRIVATE native diagnostic'))
    await Promise.resolve()
    expect(realpath).not.toHaveBeenCalled()
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      picker.choose(owner, root, new AbortController().signal),
    ).resolves.toBeUndefined()
  },
)
