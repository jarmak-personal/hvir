import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MAX_CLIPBOARD_FILE_LIST_BYTES,
  readClipboardFileList,
  type ClipboardFileListFormat,
} from '../src/main/project-file-operations/clipboard-file-list'
import { MAX_EXTERNAL_FILE_SOURCES } from '../src/shared'

describe('readClipboardFileList', () => {
  it('decodes real binary plist filenames, including spaces and Unicode', () => {
    expect(
      readClipboardFileList(
        source('NSFilenamesPboardType', binaryFixture('filenames')),
        'darwin',
      ),
    ).toEqual(['/tmp/space name.txt', '/tmp/café-雪.txt'])
  })

  it('filters unsupported binary array values without discarding valid filenames', () => {
    expect(
      readClipboardFileList(
        source('NSFilenamesPboardType', binaryFixture('mixed')),
        'darwin',
      ),
    ).toEqual(['/tmp/keep.txt'])
  })

  it.each(['dictionary', 'scalar'])('rejects a binary %s root', (name) => {
    expect(
      readClipboardFileList(
        source('NSFilenamesPboardType', binaryFixture(name)),
        'darwin',
      ),
    ).toEqual([])
  })

  it('rejects malformed binary bytes and falls back to the reviewed file URL', () => {
    const malformed = binaryFixture('filenames').subarray(0, 12)
    expect(
      readClipboardFileList(source('NSFilenamesPboardType', malformed), 'darwin'),
    ).toEqual([])
    expect(
      readClipboardFileList(
        {
          availableFormats: () => ['text/uri-list'],
          readBuffer: (format) =>
            format === 'NSFilenamesPboardType'
              ? malformed
              : Buffer.from('file:///tmp/fallback'),
        },
        'darwin',
      ),
    ).toEqual(['/tmp/fallback'])
  })

  it.each([
    '<dict><key>path</key><string>/tmp/no</string></dict>',
    '<string>/tmp/no</string>',
    '<array><integer>42</integer><string>relative</string></array>',
    '<array><string>/tmp/truncated',
  ])('rejects malformed or unsupported XML filename values: %s', (value) => {
    expect(
      readClipboardFileList(source('NSFilenamesPboardType', xmlPlist(value)), 'darwin'),
    ).toEqual([])
  })

  it('filters unsupported XML entries and decodes escaped filenames', () => {
    expect(
      readClipboardFileList(
        source(
          'NSFilenamesPboardType',
          xmlPlist(
            '<array><string>/tmp/a&amp;b.txt</string><integer>42</integer><string>relative</string></array>',
          ),
        ),
        'darwin',
      ),
    ).toEqual(['/tmp/a&b.txt'])
  })

  it.each(['public.file-url', 'text/uri-list'] as const)(
    'rejects invalid URLs in %s',
    (format) => {
      const platform = format === 'public.file-url' ? 'darwin' : 'linux'
      for (const value of [
        '/tmp/plain',
        'https://example.com/no',
        'file://remote-host/tmp/no',
        'file:///tmp/%ZZ',
        'file:///tmp/a%2Fb',
      ]) {
        expect(readClipboardFileList(source(format, value), platform)).toEqual([])
      }
    },
  )

  it('reads only the platform format allowlist', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const reads: string[] = []
      expect(
        readClipboardFileList(
          {
            availableFormats: () => [
              'text/plain',
              'text/uri-list',
              'public.file-url',
              'NSFilenamesPboardType',
            ],
            readBuffer: (format) => {
              reads.push(format)
              return Buffer.alloc(0)
            },
          },
          platform,
        ),
      ).toEqual([])
      expect(reads).toEqual(
        platform === 'darwin'
          ? ['NSFilenamesPboardType', 'public.file-url']
          : platform === 'linux'
            ? ['text/uri-list']
            : [],
      )
    }
  })

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

  it.each(['text/uri-list', 'public.file-url', 'NSFilenamesPboardType'] as const)(
    'rejects oversized %s payloads before decoding',
    (format) => {
      expect(() =>
        readClipboardFileList(
          source(format, Buffer.alloc(MAX_CLIPBOARD_FILE_LIST_BYTES + 1)),
          format === 'text/uri-list' ? 'linux' : 'darwin',
        ),
      ).toThrow('1 MiB')
    },
  )

  it('applies the source count limit to binary and XML plists', () => {
    const xml = xmlPlist(
      '<array>' +
        Array.from(
          { length: MAX_EXTERNAL_FILE_SOURCES + 1 },
          (_, i) => `<string>/tmp/source-${i}</string>`,
        ).join('') +
        '</array>',
    )
    for (const payload of [binaryFixture('too-many'), xml]) {
      expect(() =>
        readClipboardFileList(source('NSFilenamesPboardType', payload), 'darwin'),
      ).toThrow(`${MAX_EXTERNAL_FILE_SOURCES}-entry limit`)
    }
  })

  it('applies the shared external-source count bound after decoding', () => {
    const payload = Array.from(
      { length: MAX_EXTERNAL_FILE_SOURCES + 1 },
      (_, index) => `file:///tmp/source-${index}`,
    ).join('\n')

    expect(() =>
      readClipboardFileList(source('text/uri-list', payload), 'linux'),
    ).toThrow(`${MAX_EXTERNAL_FILE_SOURCES}-entry limit`)
  })
})

function source(format: ClipboardFileListFormat, value: Uint8Array | string) {
  return {
    availableFormats: () => [format],
    readBuffer: (requested: ClipboardFileListFormat) =>
      requested !== format
        ? Buffer.alloc(0)
        : typeof value === 'string'
          ? Buffer.from(value)
          : Buffer.from(value),
  }
}

function binaryFixture(name: string): Buffer {
  return readFileSync(
    new URL(`./fixtures/clipboard-file-list/${name}.plist`, import.meta.url),
  )
}

function xmlPlist(value: string): string {
  return `<?xml version="1.0"?><plist version="1.0">${value}</plist>`
}
