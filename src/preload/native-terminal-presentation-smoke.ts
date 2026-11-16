import { validNativeTerminalViewGrant } from '../shared/native-terminal-presentation'

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
let resourceCount = 0
let resourceDisabled = false

type NativePresentationResourceStage =
  | 'receiver-entry'
  | 'receiver-ineligible'
  | 'video-frame-acquired'
  | 'canvas-submitted'
  | 'frame-close-enter'
  | 'frame-close-return'
  | 'frame-close-rejected'
  | 'texture-release-enter'
  | 'texture-release-return'
  | 'texture-release-rejected'

/** The extra ID exists only on an explicitly selected smoke diagnostic payload;
 * it grants no authority. Marks are bounded/cleared and clocks remain per realm. */
export function nativePresentationResourceStage(
  stage: NativePresentationResourceStage,
  value: unknown,
): void {
  if (
    typeof __HVIR_SMOKE_BUILD__ === 'undefined' ||
    !__HVIR_SMOKE_BUILD__ ||
    resourceCount >= 2048
  )
    return
  const name = 'hvir.native.presentation.resource-stage'
  try {
    const metadata = value as
      { nativeTerminal?: unknown; hvirImportObservation?: unknown } | undefined
    const grant = metadata?.nativeTerminal
    const resource = metadata?.hvirImportObservation
    if (
      !validNativeTerminalViewGrant(grant) ||
      typeof resource !== 'number' ||
      !Number.isSafeInteger(resource) ||
      resource <= 0
    )
      return
    const atMs = performance.now(),
      timeOrigin = performance.timeOrigin
    if (!Number.isFinite(atMs) || !Number.isFinite(timeOrigin)) return
    resourceCount++
    const event = {
      schema: 1,
      event: resourceCount,
      clock: 'renderer performance.now',
      stage,
      resource,
      atMs,
      timeOrigin,
      // Reaching the cap is an explicit incomplete-history witness, including
      // when a successor renderer starts a new realm and counter.
      truncated: resourceCount === 2048,
      timelineDisabled: resourceDisabled,
      grant: {
        viewId: grant.viewId,
        nativeEpoch: grant.nativeEpoch,
        attachment: grant.attachment,
        geometrySerial: grant.geometrySerial,
        width: grant.width,
        height: grant.height,
        backingScale: grant.backingScale,
      },
    }
    if (!resourceDisabled) {
      try {
        performance.mark(name, { detail: event })
      } catch {
        /* Console evidence remains available when Timeline marking fails. */
      } finally {
        try {
          performance.clearMarks(name)
        } catch {
          resourceDisabled = true
          event.timelineDisabled = true
        }
      }
    }
    // The selected smoke's main observer accepts only this closed prefix/schema.
    // It preserves old-realm stages across reload without retaining a transcript.
    console.log('HVIR_NATIVE_RECEIVER_STAGE ' + JSON.stringify(event))
  } catch {
    /* Diagnostics cannot replace receiver/cleanup outcomes. */
  }
}

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
