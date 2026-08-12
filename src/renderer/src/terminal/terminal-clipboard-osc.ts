/** The only OSC 52 selection target hvir maps onto the system clipboard. */
const CLIPBOARD_SELECTION = 'c'
const QUERY_PAYLOAD = '?'
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Upper bound on the encoded payload, applied before decoding so an oversized
 * sequence is refused without allocating its decoded form.
 */
export const MAX_CLIPBOARD_OSC_PAYLOAD = 64 * 1024

export type ClipboardOscRefusal =
  | 'query-refused'
  | 'unsupported-selection'
  | 'oversized'
  | 'invalid-base64'
  | 'invalid-text'
  | 'empty'

export type ClipboardOscDecision =
  | {
      readonly kind: 'write'
      readonly text: string
    }
  | { readonly kind: 'refused'; readonly reason: ClipboardOscRefusal }

export interface ClipboardOscWrite {
  readonly selection: string
  /** Still base64 as ghostty-web parsed it; the engine does not decode payloads. */
  readonly data: string
}

/**
 * Decide whether an OSC 52 write hvir will honor, and what text it means.
 *
 * ghostty-web parses the escape sequence but leaves the payload base64-encoded,
 * so decoding happens here. The payload originates on whatever host the terminal
 * is attached to, making this a trust boundary: it is bounded and validated
 * before decoding, and only the decoded text crosses toward the clipboard.
 */
export function decodeClipboardOsc(event: ClipboardOscWrite): ClipboardOscDecision {
  const { selection, data } = event

  // Answering a query would write the local clipboard back down the PTY, handing
  // it to the remote host. hvir never replies to OSC 52; reads are not supported.
  // The engine reports a query as a read, so this only catches a malformed write.
  if (data === QUERY_PAYLOAD) return refused('query-refused')

  // An empty selection means the default target, which hvir treats as the
  // clipboard. Primary selections and cut buffers have no system-clipboard
  // meaning here and are left alone rather than redirected onto it.
  if (selection.length > 0 && !selection.includes(CLIPBOARD_SELECTION)) {
    return refused('unsupported-selection')
  }

  if (data.length === 0) return refused('empty')
  if (data.length > MAX_CLIPBOARD_OSC_PAYLOAD) return refused('oversized')
  if (data.length % 4 !== 0 || !STRICT_BASE64.test(data)) {
    return refused('invalid-base64')
  }

  const bytes = decodeBase64(data)
  if (!bytes) return refused('invalid-base64')

  const text = decodeUtf8(bytes)
  if (text === undefined) return refused('invalid-text')
  if (text.length === 0) return refused('empty')

  return { kind: 'write', text }
}

function refused(reason: ClipboardOscRefusal): ClipboardOscDecision {
  return { kind: 'refused', reason }
}

function decodeBase64(payload: string): Uint8Array | undefined {
  try {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return undefined
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    // Preserve an initial U+FEFF instead of treating it as transport metadata.
    // OSC 52 carries clipboard text, so every valid decoded code point belongs
    // to the copied value.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}
