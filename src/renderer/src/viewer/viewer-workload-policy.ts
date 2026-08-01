import type { TextWorkload } from '../../../shared'

export const SOURCE_HIGHLIGHT_BYTE_LIMIT = 1024 * 1024
export const SOURCE_INTERACTIVE_BYTE_LIMIT = 5 * 1024 * 1024
export const SOURCE_PREVIEW_CHARACTER_LIMIT = 512 * 1024

/** MergeView receives no more than this much complete input across both sides. */
export const DIFF_INTERACTIVE_BYTE_LIMIT = 2 * 1024 * 1024
export const DIFF_INTERACTIVE_LINE_LIMIT = 40_000
export const DIFF_PREVIEW_CHARACTER_LIMIT = 128 * 1024

export const RETAINED_WORKSPACE_LIMIT = 8
export const RETAINED_CLEAN_FILE_LIMIT = 24
export const RETAINED_CLEAN_BYTE_LIMIT = 8 * 1024 * 1024

export type DiffWorkloadSelection =
  | { readonly kind: 'interactive' }
  | {
      readonly kind: 'fallback'
      readonly reason: 'incomplete-input' | 'byte-limit' | 'line-limit'
    }

export function canHighlightSource(size: number): boolean {
  return size <= SOURCE_HIGHLIGHT_BYTE_LIMIT
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
