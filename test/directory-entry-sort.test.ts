import { describe, expect, it } from 'vitest'

import { compareDirectoryEntries } from '../src/renderer/src/tree/directory-entry-sort'
import type { DirEntry } from '../src/shared'

describe('directory entry sorting', () => {
  it('sorts numeric filename segments by value', () => {
    const entries: DirEntry[] = [
      { name: '1000.txt', type: 'file' },
      { name: '10.txt', type: 'file' },
      { name: '2.txt', type: 'file' },
      { name: '100.txt', type: 'file' },
      { name: '1.txt', type: 'file' },
    ]

    expect(entries.sort(compareDirectoryEntries).map((entry) => entry.name)).toEqual([
      '1.txt',
      '2.txt',
      '10.txt',
      '100.txt',
      '1000.txt',
    ])
  })

  it('keeps directories and directory-like symlinks ahead of files', () => {
    const entries: DirEntry[] = [
      { name: '1.txt', type: 'file' },
      { name: '20-dir', type: 'dir' },
      { name: '3-link', type: 'symlink' },
      { name: '2.txt', type: 'file' },
    ]

    expect(entries.sort(compareDirectoryEntries)).toEqual([
      { name: '3-link', type: 'symlink' },
      { name: '20-dir', type: 'dir' },
      { name: '1.txt', type: 'file' },
      { name: '2.txt', type: 'file' },
    ])
  })
})
