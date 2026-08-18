import { describe, expect, it } from 'vitest'

import {
  canRevealInFileManager,
  fileManagerRevealLabel,
} from '../src/renderer/src/tree/file-manager-reveal'
import { asHostId, hostPath, localPath } from '../src/shared'

describe('Files file-manager reveal policy', () => {
  it.each(['file', 'dir', 'symlink'] as const)(
    'offers local %s entries without broadening unsupported entry types',
    (type) => {
      expect(canRevealInFileManager(localPath('/repo/entry'), type)).toBe(true)
    },
  )

  it('omits SSH and unsupported local entries', () => {
    expect(
      canRevealInFileManager(hostPath(asHostId('ssh:example'), '/repo/entry'), 'file'),
    ).toBe(false)
    expect(canRevealInFileManager(localPath('/repo/socket'), 'other')).toBe(false)
  })

  it('uses the primary-platform file-manager label', () => {
    expect(fileManagerRevealLabel('MacIntel')).toBe('Reveal in Finder')
    expect(fileManagerRevealLabel('Linux x86_64')).toBe('Show in File Manager')
  })
})
