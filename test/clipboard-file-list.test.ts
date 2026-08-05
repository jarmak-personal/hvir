import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MAX_CLIPBOARD_FILE_LIST_BYTES,
  readClipboardFileList,
  type ClipboardFileListFormat,
} from '../src/main/project-file-operations/clipboard-file-list'

describe('readClipboardFileList', () => {
  it('decodes Linux URI lists with comments, CRLF, localhost, and percent escapes', () => {
    const payload = Buffer.from(
      `# copied files\r\n${pathToFileURL('/tmp/space name.txt').href}\r\nfile://localhost/tmp/two\r\nhttps://example.com/nope\r\n`,
    )

    expect(readClipboardFileList(source('text/uri-list', payload), 'linux')).toEqual([
      '/tmp/space name.txt',
      '/tmp/two',
    ])
  })

  it('decodes the reviewed macOS file URL and XML filename formats', () => {
    expect(
      readClipboardFileList(
        source('public.file-url', Buffer.from('file:///tmp/one.txt\0')),
        'darwin',
      ),
    ).toEqual(['/tmp/one.txt'])
    expect(
      readClipboardFileList(
        source(
          'NSFilenamesPboardType',
          Buffer.from(
            '<?xml version="1.0"?><plist version="1.0"><array><string>/tmp/two.txt</string></array></plist>',
          ),
        ),
        'darwin',
      ),
    ).toEqual(['/tmp/two.txt'])
  })

  it('probes reviewed macOS formats despite Electron availability normalization', () => {
    const source = {
      availableFormats: () => ['text/uri-list'],
      readBuffer: (format: ClipboardFileListFormat) =>
        format === 'NSFilenamesPboardType'
          ? Buffer.from(
              '<?xml version="1.0"?><plist version="1.0"><array><string>/tmp/one.txt</string><string>/tmp/two.txt</string></array></plist>',
            )
          : Buffer.from('file:///tmp/one.txt'),
    }

    expect(readClipboardFileList(source, 'darwin')).toEqual([
      '/tmp/one.txt',
      '/tmp/two.txt',
    ])
  })

  it('does not reinterpret macOS plain text when reviewed native probes are empty', () => {
    expect(
      readClipboardFileList(
        {
          availableFormats: () => ['text/plain'],
          readBuffer: () => Buffer.alloc(0),
        },
        'darwin',
      ),
    ).toEqual([])
  })

  it('never treats plain text or unsupported remote file authorities as paths', () => {
    expect(
      readClipboardFileList(source('text/plain' as never, '/tmp/no'), 'linux'),
    ).toEqual([])
    expect(
      readClipboardFileList(
        source('text/uri-list', 'file://remote-host/tmp/no'),
        'linux',
      ),
    ).toEqual([])
  })

  it('rejects oversized reviewed-format payloads before decoding', () => {
    expect(() =>
      readClipboardFileList(
        source('text/uri-list', Buffer.alloc(MAX_CLIPBOARD_FILE_LIST_BYTES + 1)),
        'linux',
      ),
    ).toThrow('1 MiB')
  })
})

function source(format: ClipboardFileListFormat, value: Uint8Array | string) {
  return {
    availableFormats: () => [format],
    readBuffer: () =>
      typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
  }
}
