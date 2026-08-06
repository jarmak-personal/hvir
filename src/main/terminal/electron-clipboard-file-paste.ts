import { fileURLToPath } from 'node:url'

import { clipboard } from 'electron'

import { terminalClipboardFilePastePath } from '../../shared'

export const GNOME_COPIED_FILES_FORMAT = 'x-special/gnome-copied-files'
export const URI_LIST_FORMAT = 'text/uri-list'
export const MAX_NATIVE_FILE_CLIPBOARD_BYTES = 64 * 1024

export interface NativeFileClipboardSource {
  availableFormats(): string[]
  readBuffer(format: string): Uint8Array
}

/** Read one local file path from Linux file-manager clipboard formats. */
export class ElectronClipboardFilePaste {
  constructor(
    private readonly source: NativeFileClipboardSource = clipboard,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  read(): string | undefined {
    if (this.platform !== 'linux') return undefined

    const formats = this.source.availableFormats()
    const gnomeFormat = formats.find(
      (format) => format.toLowerCase() === GNOME_COPIED_FILES_FORMAT,
    )
    if (gnomeFormat) {
      const gnomePath = this.readFormat(gnomeFormat, 'gnome')
      if (gnomePath !== undefined) return gnomePath ?? undefined
    }

    const uriListFormat = formats.find(
      (format) => format.toLowerCase().split(';', 1)[0] === URI_LIST_FORMAT,
    )
    return uriListFormat
      ? (this.readFormat(uriListFormat, 'uri-list') ?? undefined)
      : undefined
  }

  private readFormat(
    format: string,
    kind: 'gnome' | 'uri-list',
  ): string | null | undefined {
    let bytes: Uint8Array
    try {
      bytes = this.source.readBuffer(format)
    } catch {
      return undefined
    }
    if (bytes.byteLength === 0) return undefined
    if (bytes.byteLength > MAX_NATIVE_FILE_CLIPBOARD_BYTES) return null

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return terminalPathFromFileClipboardText(text, kind) ?? null
    } catch {
      return null
    }
  }
}

export function terminalPathFromFileClipboardText(
  text: string,
  kind: 'gnome' | 'uri-list',
): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

  const uriLines = kind === 'gnome' ? gnomeUriLines(lines) : lines
  if (!uriLines || uriLines.length !== 1) return undefined

  try {
    const url = new URL(uriLines[0]!)
    if (url.protocol !== 'file:' || url.search || url.hash) return undefined
    return terminalClipboardFilePastePath(fileURLToPath(url))
  } catch {
    return undefined
  }
}

function gnomeUriLines(lines: readonly string[]): readonly string[] | undefined {
  const operation = lines[0]?.toLowerCase()
  if (operation !== 'copy' && operation !== 'cut') return undefined
  return lines.slice(1)
}
