export const SOURCE_HIGHLIGHT_BYTE_LIMIT = 1024 * 1024
export const SOURCE_INTERACTIVE_BYTE_LIMIT = 5 * 1024 * 1024
export const SOURCE_PREVIEW_CHARACTER_LIMIT = 512 * 1024

/** Each Git side is bounded before it crosses the utility-process/renderer seam. */
export const DIFF_INPUT_BYTE_LIMIT = 2 * 1024 * 1024
/** MergeView receives no more than this much complete input across both sides. */
export const DIFF_INTERACTIVE_BYTE_LIMIT = 2 * 1024 * 1024
export const DIFF_INTERACTIVE_LINE_LIMIT = 40_000
export const DIFF_PREVIEW_CHARACTER_LIMIT = 128 * 1024

export const RETAINED_WORKSPACE_LIMIT = 8
export const RETAINED_CLEAN_FILE_LIMIT = 24
export const RETAINED_CLEAN_BYTE_LIMIT = 8 * 1024 * 1024
export const TEXT_PREFIX_MAX_BYTE_LIMIT = 64 * 1024 * 1024

export interface TextWorkload {
  readonly content: string
  /** UTF-8 bytes included in `content`, not the size of an omitted suffix. */
  readonly byteLength: number
  /** Lines included in `content`; partial inputs never claim a full-file count. */
  readonly lineCount: number
  readonly complete: boolean
}

export type DiffWorkloadSelection =
  | { readonly kind: 'interactive' }
  | {
      readonly kind: 'fallback'
      readonly reason: 'incomplete-input' | 'byte-limit' | 'line-limit'
    }

export function canHighlightSource(size: number): boolean {
  return size <= SOURCE_HIGHLIGHT_BYTE_LIMIT
}

export function assertTextPrefixByteLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > TEXT_PREFIX_MAX_BYTE_LIMIT
  ) {
    throw new Error('Invalid text prefix byte limit')
  }
}

export function canUseInteractiveSource(size: number): boolean {
  return size <= SOURCE_INTERACTIVE_BYTE_LIMIT
}

export function sourcePreview(content: string): string {
  return content.slice(0, SOURCE_PREVIEW_CHARACTER_LIMIT)
}

export function diffPreview(content: string): string {
  return content.slice(0, DIFF_PREVIEW_CHARACTER_LIMIT)
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

export function selectDiffWorkload(
  base: Pick<TextWorkload, 'byteLength' | 'lineCount' | 'complete'>,
  current: Pick<TextWorkload, 'byteLength' | 'lineCount' | 'complete'>,
): DiffWorkloadSelection {
  if (!base.complete || !current.complete) {
    return { kind: 'fallback', reason: 'incomplete-input' }
  }
  if (base.byteLength + current.byteLength > DIFF_INTERACTIVE_BYTE_LIMIT) {
    return { kind: 'fallback', reason: 'byte-limit' }
  }
  if (base.lineCount + current.lineCount > DIFF_INTERACTIVE_LINE_LIMIT) {
    return { kind: 'fallback', reason: 'line-limit' }
  }
  return { kind: 'interactive' }
}

export function textLineCount(content: string): number {
  if (content.length === 0) return 1
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines++
  }
  return lines
}
