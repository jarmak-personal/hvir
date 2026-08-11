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
      /** Reported rather than silently absorbed, so refusals stay debuggable. */
      readonly removedControls: number
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

  const sanitized = stripControlCharacters(text)
  if (sanitized.text.length === 0) return refused('empty')

  return {
    kind: 'write',
    text: sanitized.text,
    removedControls: sanitized.removed,
  }
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Drop C0 controls and DEL, keeping tab and newline. A carriage return or an
 * escape sequence surviving into the clipboard executes when the text is later
 * pasted into a shell that is not using bracketed paste.
 */
function stripControlCharacters(value: string): {
  readonly text: string
  readonly removed: number
} {
  let removed = 0
  let text = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const isKeptWhitespace = code === 0x09 || code === 0x0a
    if ((code < 0x20 && !isKeptWhitespace) || code === 0x7f) {
      removed += 1
      continue
    }
    text += character
  }
  return { text, removed }
}
