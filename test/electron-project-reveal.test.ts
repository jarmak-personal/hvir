import { describe, expect, it, vi } from 'vitest'

import { electronReveal } from '../src/main/project-host/electron-project-reveal'
import { localPath } from '../src/shared'

describe('Electron project reveal adapter', () => {
  it('delegates the exact validated local entry to Electron shell.showItemInFolder', () => {
    const showItemInFolder = vi.fn()
    const reveal = electronReveal({ showItemInFolder })

    reveal(localPath('/exact/project/link.txt'))

    expect(showItemInFolder).toHaveBeenCalledOnce()
    expect(showItemInFolder).toHaveBeenCalledWith('/exact/project/link.txt')
  })
})
