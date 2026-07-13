import { describe, expect, it } from 'vitest'

import { splitFileName } from '../src/renderer/src/tree/file-name'

describe('file tree name presentation', () => {
  it('separates only the final extension', () => {
    expect(splitFileName('worker-host.typecheck.ts')).toEqual({
      stem: 'worker-host.typecheck',
      extension: '.ts',
    })
  })

  it('keeps dotfiles and trailing dots intact', () => {
    expect(splitFileName('.gitignore')).toEqual({ stem: '.gitignore', extension: '' })
    expect(splitFileName('release.')).toEqual({ stem: 'release.', extension: '' })
  })
})
