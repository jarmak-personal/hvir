import { describe, expect, it } from 'vitest'

import {
  DIFF_INPUT_BYTE_LIMIT,
  DIFF_INTERACTIVE_BYTE_LIMIT,
  DIFF_INTERACTIVE_LINE_LIMIT,
  DIFF_PREVIEW_CHARACTER_LIMIT,
  SOURCE_HIGHLIGHT_BYTE_LIMIT,
  SOURCE_INTERACTIVE_BYTE_LIMIT,
  SOURCE_PREVIEW_CHARACTER_LIMIT,
  boundTextWorkload,
  canHighlightSource,
  canUseInteractiveSource,
  diffPreview,
  selectDiffWorkload,
  sourcePreview,
} from '../src/shared'

describe('viewer workload policy', () => {
  it('keeps source highlighting below and at its existing byte limit', () => {
    expect(canHighlightSource(SOURCE_HIGHLIGHT_BYTE_LIMIT - 1)).toBe(true)
    expect(canHighlightSource(SOURCE_HIGHLIGHT_BYTE_LIMIT)).toBe(true)
    expect(canHighlightSource(SOURCE_HIGHLIGHT_BYTE_LIMIT + 1)).toBe(false)
  })

  it('keeps CodeMirror below and at its existing source byte limit', () => {
    expect(canUseInteractiveSource(SOURCE_INTERACTIVE_BYTE_LIMIT - 1)).toBe(true)
    expect(canUseInteractiveSource(SOURCE_INTERACTIVE_BYTE_LIMIT)).toBe(true)
    expect(canUseInteractiveSource(SOURCE_INTERACTIVE_BYTE_LIMIT + 1)).toBe(false)
  })

  it('bounds the existing source preview below, at, and above its character limit', () => {
    expect(sourcePreview('a'.repeat(SOURCE_PREVIEW_CHARACTER_LIMIT - 1))).toHaveLength(
      SOURCE_PREVIEW_CHARACTER_LIMIT - 1,
    )
    expect(sourcePreview('a'.repeat(SOURCE_PREVIEW_CHARACTER_LIMIT))).toHaveLength(
      SOURCE_PREVIEW_CHARACTER_LIMIT,
    )
    expect(sourcePreview('a'.repeat(SOURCE_PREVIEW_CHARACTER_LIMIT + 1))).toHaveLength(
      SOURCE_PREVIEW_CHARACTER_LIMIT,
    )
  })

  it('marks Git input below and at its transport limit complete, then truncates', () => {
    expect(
      boundTextWorkload('a'.repeat(DIFF_INPUT_BYTE_LIMIT - 1), DIFF_INPUT_BYTE_LIMIT),
    ).toMatchObject({ byteLength: DIFF_INPUT_BYTE_LIMIT - 1, complete: true })
    expect(
      boundTextWorkload('a'.repeat(DIFF_INPUT_BYTE_LIMIT), DIFF_INPUT_BYTE_LIMIT),
    ).toMatchObject({ byteLength: DIFF_INPUT_BYTE_LIMIT, complete: true })
    expect(
      boundTextWorkload('a'.repeat(DIFF_INPUT_BYTE_LIMIT + 1), DIFF_INPUT_BYTE_LIMIT),
    ).toMatchObject({ byteLength: DIFF_INPUT_BYTE_LIMIT, complete: false })
  })

  it('allows complete diffs below and at the byte budget, then falls back', () => {
    expect(
      selectDiffWorkload(input(DIFF_INTERACTIVE_BYTE_LIMIT - 2, 1), input(1, 1)),
    ).toEqual({ kind: 'interactive' })
    expect(
      selectDiffWorkload(input(DIFF_INTERACTIVE_BYTE_LIMIT - 1, 1), input(1, 1)),
    ).toEqual({ kind: 'interactive' })
    expect(
      selectDiffWorkload(input(DIFF_INTERACTIVE_BYTE_LIMIT, 1), input(1, 1)),
    ).toEqual({ kind: 'fallback', reason: 'byte-limit' })
  })

  it('allows complete diffs below and at the line budget, then falls back', () => {
    expect(
      selectDiffWorkload(input(1, DIFF_INTERACTIVE_LINE_LIMIT - 2), input(1, 1)),
    ).toEqual({ kind: 'interactive' })
    expect(
      selectDiffWorkload(input(1, DIFF_INTERACTIVE_LINE_LIMIT - 1), input(1, 1)),
    ).toEqual({ kind: 'interactive' })
    expect(
      selectDiffWorkload(input(1, DIFF_INTERACTIVE_LINE_LIMIT), input(1, 1)),
    ).toEqual({ kind: 'fallback', reason: 'line-limit' })
  })

  it('never sends incomplete input to MergeView policy', () => {
    expect(selectDiffWorkload(input(1, 1, false), input(1, 1))).toEqual({
      kind: 'fallback',
      reason: 'incomplete-input',
    })
  })

  it('bounds each read-only diff preview below, at, and above its character limit', () => {
    expect(diffPreview('a'.repeat(DIFF_PREVIEW_CHARACTER_LIMIT - 1))).toHaveLength(
      DIFF_PREVIEW_CHARACTER_LIMIT - 1,
    )
    expect(diffPreview('a'.repeat(DIFF_PREVIEW_CHARACTER_LIMIT))).toHaveLength(
      DIFF_PREVIEW_CHARACTER_LIMIT,
    )
    expect(diffPreview('a'.repeat(DIFF_PREVIEW_CHARACTER_LIMIT + 1))).toHaveLength(
      DIFF_PREVIEW_CHARACTER_LIMIT,
    )
  })
})

function input(
  byteLength: number,
  lineCount: number,
  complete = true,
): {
  readonly byteLength: number
  readonly lineCount: number
  readonly complete: boolean
} {
  return { byteLength, lineCount, complete }
}
