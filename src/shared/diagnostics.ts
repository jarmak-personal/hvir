/** Closed renderer diagnostic transport contracts. No arbitrary payload field is allowed. */

export const RENDERER_DIAGNOSTIC_VERSION = 1
export const MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS = 16
export const MAX_RENDERER_DIAGNOSTIC_QUEUE_EVENTS = 64
export const MAX_RENDERER_DIAGNOSTIC_BATCH_BYTES = 16 * 1024
export const MAX_RENDERER_DIAGNOSTIC_QUEUE_BYTES = 64 * 1024

export interface RendererDiagnosticSession {
  readonly version: typeof RENDERER_DIAGNOSTIC_VERSION
  readonly ownerGeneration: number
  readonly sessionId: string
}

export interface RenderContainmentDiagnostic {
  readonly version: typeof RENDERER_DIAGNOSTIC_VERSION
  readonly occurrenceId: string
}

export interface RendererDiagnosticDroppedCounts {
  readonly invalid: number
  readonly queue: number
  readonly rate: number
  readonly unavailable: number
}

export interface RenderContainmentDiagnosticBatch {
  readonly version: typeof RENDERER_DIAGNOSTIC_VERSION
  readonly session: RendererDiagnosticSession
  readonly events: readonly RenderContainmentDiagnostic[]
  readonly dropped: RendererDiagnosticDroppedCounts
}

export function isDiagnosticOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}
