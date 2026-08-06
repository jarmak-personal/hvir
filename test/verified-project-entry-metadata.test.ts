import { describe, expect, it } from 'vitest'

import { normalizeVerifiedProjectEntryMetadata } from '../src/main/project-file-operations/verified-project-entry-metadata'
import type { Stat } from '../src/shared'

describe('verified project entry metadata', () => {
  it.each([
    {
      label: 'regular file',
      stat: entry({ type: 'file', size: 4, mode: 0o664, mtimeMs: 1_234 }),
      value: { type: 'file', size: 4, mode: 0o644, mtimeSeconds: 1 },
    },
    {
      label: 'executable file',
      stat: entry({ type: 'file', size: 7, mode: 0o710, mtimeMs: 2_999 }),
      value: { type: 'file', size: 7, mode: 0o755, mtimeSeconds: 2 },
    },
    {
      label: 'directory',
      stat: entry({ type: 'dir', size: 96, mode: 0o700, mtimeMs: 3_001 }),
      value: { type: 'directory', size: 0, mode: 0o755, mtimeSeconds: 3 },
    },
  ])('normalizes $label for copy and removal parity', ({ stat, value }) => {
    expect(normalizeVerifiedProjectEntryMetadata(stat)).toEqual({ ok: true, value })
  })

  it.each([
    ['symbolic link', entry({ type: 'symlink' }), 'unsupported-entry'],
    ['other entry', entry({ type: 'other' }), 'unsupported-entry'],
    ['negative size', entry({ size: -1 }), 'unusable-metadata'],
    ['fractional size', entry({ size: 1.5 }), 'unusable-metadata'],
    ['unsafe size', entry({ size: Number.MAX_SAFE_INTEGER + 1 }), 'unusable-metadata'],
    [
      'non-finite mtime',
      entry({ mtimeMs: Number.POSITIVE_INFINITY }),
      'unusable-metadata',
    ],
  ] as const)(
    'rejects %s without producing destructive metadata',
    (_label, stat, reason) => {
      expect(normalizeVerifiedProjectEntryMetadata(stat)).toEqual({ ok: false, reason })
    },
  )
})

function entry(overrides: Partial<Stat>): Stat {
  return { type: 'file', size: 1, mode: 0o644, mtimeMs: 1_000, ...overrides }
}
