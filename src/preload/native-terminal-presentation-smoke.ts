/** GPU boundary evidence; guarded measurement calls are disabled in production. */
type NativePresentationSpan =
  | 'get-video-frame'
  | 'canvas-create'
  | 'canvas-upload'
  | 'canvas-submit'
  | 'frame-close'
  | 'texture-release'

let disabled = false

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
