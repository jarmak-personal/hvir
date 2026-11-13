/** Main-issued presentation authority. No process-local resource appears here. */
export interface NativeTerminalViewGrant {
  readonly viewId: string
  readonly attachment: number
  readonly nativeEpoch: string
  readonly geometrySerial: number
  readonly width: number
  readonly height: number
  readonly backingScale: number
}
export interface NativeTerminalPresentedFrame {
  readonly nativeTerminal: NativeTerminalViewGrant
  readonly origin: number
  readonly colorSpace: number
}
export interface NativeTerminalPixelFrame extends NativeTerminalPresentedFrame {
  readonly bytes: Uint8Array
  readonly stride: number
  /** Compatibility-only RGBA straight alpha, normalized top-left off UI loops. */
  readonly premultiplied: false
}
export type NativeTerminalPresentationMode =
  'native-gpu' | 'native-pixels' | 'unavailable'
export interface NativeTerminalPresentationStatus {
  readonly viewId: string
  readonly mode: NativeTerminalPresentationMode
  readonly reason?:
    | 'import-unavailable'
    | 'renderer-lost'
    | 'native-lost'
    | 'pixel-bound'
    | 'geometry-failed'
}
export type NativeTerminalPresentationAcknowledgement =
  | { readonly kind: 'pixels'; readonly ticket: string; readonly accepted: boolean }
  | { readonly kind: 'renderer-failure'; readonly grant: NativeTerminalViewGrant }
export const NATIVE_TERMINAL_PRESENTATION = {
  grantChannel: 'native-terminal:presentation-grant',
  pixelsChannel: 'native-terminal:presentation-pixels',
  statusChannel: 'native-terminal:presentation-status',
  acknowledgementChannel: 'native-terminal:presentation-ack',
  maximumViews: 32,
  maximumPixelBytes: 16 * 1024 * 1024,
  compatibilityIntervalMs: 67,
} as const

/** Trusted renderer registers a mount; only a matching main grant permits drawing. */
export interface NativeTerminalPresentationApi {
  mount(viewId: string, elementId: string): void
  unmount(viewId: string): void
  onStatus(listener: (status: NativeTerminalPresentationStatus) => void): () => void
}
export function validNativeTerminalScale(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 4
}
export function validNativeTerminalViewGrant(
  value: unknown,
): value is NativeTerminalViewGrant {
  if (!value || typeof value !== 'object') return false
  const g = value as NativeTerminalViewGrant
  return (
    typeof g.viewId === 'string' &&
    /^[a-f0-9-]{36}$/.test(g.viewId) &&
    typeof g.nativeEpoch === 'string' &&
    /^[a-f0-9-]{36}$/.test(g.nativeEpoch) &&
    [g.attachment, g.geometrySerial].every((n) => Number.isSafeInteger(n) && n > 0) &&
    [g.width, g.height].every((n) => Number.isInteger(n) && n >= 32 && n <= 8192) &&
    validNativeTerminalScale(g.backingScale)
  )
}
export function sameNativeTerminalView(
  a: NativeTerminalViewGrant,
  b: NativeTerminalViewGrant,
): boolean {
  return (
    a.viewId === b.viewId &&
    a.attachment === b.attachment &&
    a.nativeEpoch === b.nativeEpoch &&
    a.geometrySerial === b.geometrySerial &&
    a.width === b.width &&
    a.height === b.height &&
    a.backingScale === b.backingScale
  )
}
