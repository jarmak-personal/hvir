import { describe, expect, it, vi } from 'vitest'

import {
  ElectronClipboardFilePaste,
  GNOME_COPIED_FILES_FORMAT,
  MAX_NATIVE_FILE_CLIPBOARD_BYTES,
  URI_LIST_FORMAT,
  terminalPathFromFileClipboardText,
} from '../src/main/terminal/electron-clipboard-file-paste'
import { terminalClipboardFilePasteText } from '../src/preload/terminal-clipboard-file-paste'
import { resolveGhosttyTerminalFilePaste } from '../src/renderer/src/terminal/ghostty-terminal-file-paste'
import type { HvirApi } from '../src/shared'

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

describe('terminal native file clipboard capability', () => {
  it.each([
    ['copy\nfile:///home/user/Downloads/requirements.txt\n', 'gnome'],
    ['cut\r\nfile:///home/user/Downloads/file%20with%20spaces.txt\r\n', 'gnome'],
    ['# copied file\r\nfile:///home/user/Downloads/requirements.txt\r\n', 'uri-list'],
  ] as const)('decodes one local file URI from %s', (text, kind) => {
    expect(terminalPathFromFileClipboardText(text, kind)).toMatch(
      /^\/home\/user\/Downloads\//,
    )
  })

  it.each([
    ['copy\nfile:///one\nfile:///two\n', 'gnome'],
    ['copy\nhttps://example.com/file.txt\n', 'gnome'],
    ['move\nfile:///home/user/file.txt\n', 'gnome'],
    ['file://remote-host/home/user/file.txt\n', 'uri-list'],
    ['file:///home/user/file.txt?query\n', 'uri-list'],
    ['file:///home/user/file%0Aname.txt\n', 'uri-list'],
  ] as const)(
    'rejects unsafe or non-singular native clipboard text: %s',
    (text, kind) => {
      expect(terminalPathFromFileClipboardText(text, kind)).toBeUndefined()
    },
  )

  it('prefers the GNOME operation-bearing format and reads only its bounded bytes', () => {
    const readBuffer = vi.fn((format: string) => {
      expect(format).toBe(GNOME_COPIED_FILES_FORMAT)
      return Buffer.from('copy\nfile:///home/user/Downloads/requirements.txt\n')
    })
    const reader = new ElectronClipboardFilePaste(
      {
        availableFormats: () => [URI_LIST_FORMAT, GNOME_COPIED_FILES_FORMAT],
        readBuffer,
      },
      'linux',
    )

    expect(reader.read()).toBe('/home/user/Downloads/requirements.txt')
    expect(readBuffer).toHaveBeenCalledTimes(1)
  })

  it('accepts a parameterized URI-list format as the Linux fallback', () => {
    const format = 'text/uri-list;charset=utf-8'
    const reader = new ElectronClipboardFilePaste(
      {
        availableFormats: () => [format],
        readBuffer: (received) => {
          expect(received).toBe(format)
          return Buffer.from('file:///home/user/Downloads/requirements.txt\r\n')
        },
      },
      'linux',
    )

    expect(reader.read()).toBe('/home/user/Downloads/requirements.txt')
  })

  it('does not read native formats outside Linux or when data is oversized', () => {
    const readBuffer = vi.fn(() => new Uint8Array(MAX_NATIVE_FILE_CLIPBOARD_BYTES + 1))
    const source = {
      availableFormats: () => [URI_LIST_FORMAT],
      readBuffer,
    }

    expect(new ElectronClipboardFilePaste(source, 'darwin').read()).toBeUndefined()
    expect(readBuffer).not.toHaveBeenCalled()
    expect(new ElectronClipboardFilePaste(source, 'linux').read()).toBeUndefined()
    expect(readBuffer).toHaveBeenCalledTimes(1)
  })
})

describe('Ghostty terminal file paste selection', () => {
  it('uses the synchronous preload capability for a browser File', () => {
    const invoke = vi.fn()
    const resolveTerminalClipboardFilePaste = vi.fn(
      () => '/home/user/Downloads/requirements.txt',
    )
    const api = { invoke, resolveTerminalClipboardFilePaste } as Pick<
      HvirApi,
      'invoke' | 'resolveTerminalClipboardFilePaste'
    >

    expect(resolveGhosttyTerminalFilePaste(api, FILE)).toBe(
      '/home/user/Downloads/requirements.txt',
    )
    expect(resolveTerminalClipboardFilePaste).toHaveBeenCalledExactlyOnceWith(FILE)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('requests the native clipboard capability when Chromium exposes no File', async () => {
    const invoke = vi.fn(() => Promise.resolve('/home/user/Downloads/requirements.txt'))
    const resolveTerminalClipboardFilePaste = vi.fn()
    const api = { invoke, resolveTerminalClipboardFilePaste } as Pick<
      HvirApi,
      'invoke' | 'resolveTerminalClipboardFilePaste'
    >

    await expect(resolveGhosttyTerminalFilePaste(api, undefined)).resolves.toBe(
      '/home/user/Downloads/requirements.txt',
    )
    expect(invoke).toHaveBeenCalledExactlyOnceWith('terminal:resolve-file-clipboard', {})
    expect(resolveTerminalClipboardFilePaste).not.toHaveBeenCalled()
  })
})
