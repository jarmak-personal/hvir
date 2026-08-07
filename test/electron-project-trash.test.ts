import { describe, expect, it, vi } from 'vitest'

import { electronTrash } from '../src/main/project-host/electron-project-trash'
import { localPath } from '../src/shared'

describe('Electron project trash adapter', () => {
  it('delegates the exact local path to Electron shell.trashItem', async () => {
    const trashItem = vi.fn(() => Promise.resolve())
    const trash = electronTrash({ trashItem })

    await trash(localPath('/exact/project/entry.txt'))

    expect(trashItem).toHaveBeenCalledOnce()
    expect(trashItem).toHaveBeenCalledWith('/exact/project/entry.txt')
  })
})
