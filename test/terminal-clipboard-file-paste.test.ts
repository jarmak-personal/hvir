import { describe, expect, it, vi } from 'vitest'

import { terminalClipboardFilePasteText } from '../src/preload/terminal-clipboard-file-paste'

const FILE = { name: 'requirements.txt' } as File

describe('terminal clipboard file paste preload capability', () => {
  it.each([
    '/home/user/project/requirements.txt',
    '/home/user/project/file with spaces.txt',
    'C:\\Users\\user\\project\\requirements.txt',
  ])('returns one local absolute path unchanged: %s', (candidate) => {
    const readNativePath = vi.fn(() => candidate)

    expect(terminalClipboardFilePasteText(FILE, readNativePath)).toBe(candidate)
    expect(readNativePath).toHaveBeenCalledExactlyOnceWith(FILE)
  })

  it.each([
    '',
    'requirements.txt',
    './requirements.txt',
    'file:///home/user/project/requirements.txt',
    '\\server\\share\\requirements.txt',
    '/home/user/project/requirements\n.txt',
    '/home/user/project/requirements\u001b.txt',
  ])(
    'rejects unresolved, non-absolute, remote, or control-bearing text: %s',
    (candidate) => {
      expect(terminalClipboardFilePasteText(FILE, () => candidate)).toBeUndefined()
    },
  )
})
