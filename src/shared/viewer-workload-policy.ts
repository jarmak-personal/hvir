/** Each Git side is bounded before it crosses the utility-process/renderer seam. */
export const DIFF_INPUT_BYTE_LIMIT = 2 * 1024 * 1024

export interface TextWorkload {
  readonly content: string
  /** UTF-8 bytes included in `content`, not the size of an omitted suffix. */
  readonly byteLength: number
  /** Lines included in `content`; partial inputs never claim a full-file count. */
  readonly lineCount: number
  readonly complete: boolean
}

export function assertTextPrefixByteLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DIFF_INPUT_BYTE_LIMIT
  ) {
    throw new Error('Invalid text prefix byte limit')
  }
}

export function measureTextWorkload(content: string, complete = true): TextWorkload {
  return {
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
    lineCount: textLineCount(content),
    complete,
  }
}

export function boundTextWorkload(
  content: string,
  maxBytes: number,
  complete = true,
): TextWorkload {
  const encoded = new TextEncoder().encode(content)
  if (complete && encoded.byteLength <= maxBytes) {
    return {
      content,
      byteLength: encoded.byteLength,
      lineCount: textLineCount(content),
      complete: true,
    }
  }
  const bounded = new TextDecoder().decode(encoded.slice(0, maxBytes), {
    stream: true,
  })
  return measureTextWorkload(bounded, false)
}

export function textLineCount(content: string): number {
  if (content.length === 0) return 1
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines++
  }
  return lines
}
