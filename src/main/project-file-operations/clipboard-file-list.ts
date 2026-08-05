import { fileURLToPath } from 'node:url'

import bplistParser from 'bplist-parser'
import { parse as parsePlist } from 'plist'

export const MAX_EXTERNAL_FILE_SOURCES = 256
export const MAX_CLIPBOARD_FILE_LIST_BYTES = 1024 * 1024

export type ClipboardFileListFormat =
  'public.file-url' | 'NSFilenamesPboardType' | 'text/uri-list'

export interface ClipboardFileListSource {
  availableFormats(): readonly string[]
  readBuffer(format: ClipboardFileListFormat): Uint8Array
}

/** Fixed-format disk-backed file-list decoder; plain clipboard text is never consulted. */
export function readClipboardFileList(
  source: ClipboardFileListSource,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const available = new Set(source.availableFormats())
  const formats: readonly ClipboardFileListFormat[] =
    platform === 'darwin'
      ? ['NSFilenamesPboardType', 'public.file-url']
      : platform === 'linux'
        ? ['text/uri-list']
        : []
  for (const format of formats) {
    // Electron normalizes both reviewed macOS pasteboard types to
    // `text/uri-list` in availableFormats(). Probe only the exact native
    // allowlist there; an absent format returns an empty buffer. Keep Linux
    // gated on its reviewed MIME type.
    if (platform !== 'darwin' && !available.has(format)) continue
    const payload = Buffer.from(source.readBuffer(format))
    if (payload.byteLength === 0) continue
    if (payload.byteLength > MAX_CLIPBOARD_FILE_LIST_BYTES) {
      throw new Error('The clipboard file list exceeds the 1 MiB limit')
    }
    const values =
      format === 'NSFilenamesPboardType'
        ? parseLegacyMacFilenames(payload)
        : parseFileUriPayload(payload, format === 'text/uri-list')
    if (values.length > MAX_EXTERNAL_FILE_SOURCES) {
      throw new Error('The clipboard file list exceeds the 256-entry limit')
    }
    if (values.length > 0) return values
  }
  return []
}

function parseFileUriPayload(payload: Buffer, uriList: boolean): readonly string[] {
  const text = payload.toString('utf8').replace(/\0+$/u, '')
  const rows = uriList ? text.split(/\r?\n/u) : [text]
  return rows.flatMap((raw) => {
    const value = raw.trim()
    if (!value || (uriList && value.startsWith('#'))) return []
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return []
    }
    if (
      url.protocol !== 'file:' ||
      (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost')
    ) {
      return []
    }
    try {
      const path = fileURLToPath(url)
      return path.startsWith('/') ? [path] : []
    } catch {
      return []
    }
  })
}

function parseLegacyMacFilenames(payload: Buffer): readonly string[] {
  let decoded: unknown
  try {
    decoded =
      payload.subarray(0, 8).toString('ascii') === 'bplist00'
        ? bplistParser.parseBuffer(payload)[0]
        : parsePlist(payload.toString('utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(decoded)) return []
  return decoded.filter(
    (value): value is string => typeof value === 'string' && value.startsWith('/'),
  )
}
