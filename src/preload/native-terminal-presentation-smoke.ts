/** GPU boundary evidence; guarded measurement calls are disabled in production. */
type NativePresentationSpan =
  | 'get-video-frame'
  | 'canvas-create'
  | 'canvas-upload'
  | 'canvas-submit'
  | 'frame-close'
  | 'texture-release'

let disabled = false
let failureCount = 0
let failureDisabled = false

export type NativePresentationFailureStage =
  | 'receiver-factory-absent'
  | 'receiver-factory-throw'
  | 'receiver-canvas-loss-callback'
  | 'receiver-get-video-frame'
  | 'receiver-draw'
  | 'receiver-pixels'
  | 'receiver-refit-suspend'
  | 'canvas-parent-missing'
  | 'canvas-parent-disconnected'
  | 'canvas-context-unavailable'
  | 'canvas-program-unavailable'
  | 'canvas-texture-unavailable'
  | 'canvas-shader-unavailable'
  | 'canvas-shader-compile'
  | 'canvas-program-link'
  | 'canvas-uniform-unavailable'
  | 'canvas-texture-size-invalid'
  | 'canvas-initialize'
  | 'canvas-context-lost'
  | 'canvas-draw-disposed'
  | 'canvas-draw-disconnected'
  | 'canvas-draw-context-lost'
  | 'canvas-draw-size-bound'
  | 'canvas-draw-configure'
  | 'canvas-draw-upload'
  | 'canvas-pixel-disconnected'
  | 'canvas-pixel-buffer'
  | 'canvas-pixel-upload'
  | 'canvas-refit-disposed'
  | 'canvas-refit-disconnected'
type FailureFlag =
  | 'parentPresent'
  | 'parentConnected'
  | 'canvasConnected'
  | 'contextLost'
  | 'mounted'
  | 'bindingCurrent'
  | 'grantPresent'

/** Failure-only, content-free evidence, at most 32 marks per loaded preload
 * module/renderer realm. Entries are cleared after emission; observers retain
 * their own bounded records. It cannot replace a product outcome. */
export function nativePresentationFailure(
  stage: NativePresentationFailureStage,
  facts: Partial<Record<FailureFlag, boolean>>,
): void {
  if (
    typeof __HVIR_SMOKE_BUILD__ === 'undefined' ||
    !__HVIR_SMOKE_BUILD__ ||
    failureDisabled ||
    failureCount >= 32
  )
    return
  const name = 'hvir.native.presentation.failure-stage'
  try {
    const flags: Partial<Record<FailureFlag, boolean>> = {}
    for (const key of [
      'parentPresent',
      'parentConnected',
      'canvasConnected',
      'contextLost',
      'mounted',
      'bindingCurrent',
      'grantPresent',
    ] as const)
      if (typeof facts[key] === 'boolean') flags[key] = facts[key]
    failureCount++
    performance.mark(name, { detail: { stage, flags } })
  } catch {
    // Diagnostics never change the failing operation or callback's result.
  } finally {
    try {
      performance.clearMarks(name)
    } catch {
      failureDisabled = true
    }
  }
}

export function nativePresentationSpanStart(): number | undefined {
  if (disabled) return undefined
  try {
    return performance.now()
  } catch {
    return undefined
  }
}

export function nativePresentationSpanEnd(
  span: NativePresentationSpan,
  started: number | undefined,
): void {
  if (started === undefined) return
  const name = `hvir.native.presentation.${span}`
  try {
    performance.measure(name, { start: started, end: performance.now() })
  } catch {
    // Diagnostic failure must not replace a native operation's result or error.
  } finally {
    try {
      performance.clearMeasures(name)
    } catch {
      // A failed cleanup must not leave an accumulating Performance Timeline.
      disabled = true
    }
  }
}
