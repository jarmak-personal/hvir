import type { HostPath } from './host-path'
import { validNativeTerminalUuid } from './native-terminal-identities'
export interface NativeTerminalLinkIntent {
  readonly viewId: string
  readonly requestId: string
  readonly x: number
  readonly y: number
}
export interface NativeTerminalLinkActivation {
  readonly kind: 'file' | 'loopback-http' | 'external-http'
  readonly target: string
  readonly workspaceRoot: HostPath
}
export interface NativeTerminalLinkCapture {
  readonly pending: boolean
  readonly link?: NativeTerminalLinkActivation
}
export function validNativeTerminalLinkIntent(
  value: unknown,
): value is NativeTerminalLinkIntent {
  if (!value || typeof value !== 'object') return false
  const request = value as NativeTerminalLinkIntent
  return (
    validNativeTerminalUuid(request.viewId) &&
    validNativeTerminalUuid(request.requestId) &&
    [request.x, request.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 32768) &&
    Object.keys(request).every((key) => ['viewId', 'requestId', 'x', 'y'].includes(key))
  )
}
export interface NativeTerminalLinkQuery {
  readonly row: number
  readonly column: number
  readonly screen: 0 | 1
  readonly expectedSequence: number
  readonly expectedMutation: number
  readonly expectedGeometrySerial: number
}
export interface NativeTerminalLink {
  readonly uri: string
  readonly workspaceRoot: HostPath
  readonly screen: 0 | 1
  readonly row: number
  readonly column: number
  readonly streamSequence: number
  readonly snapshotMutation: number
  readonly geometrySerial: number
}
export function validNativeTerminalLinkQuery(value: NativeTerminalLinkQuery): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value.screen === 0 || value.screen === 1) &&
    value.row <= 0xffffffff &&
    value.column <= 0xffffffff &&
    [
      value.row,
      value.column,
      value.expectedSequence,
      value.expectedMutation,
      value.expectedGeometrySerial,
    ].every((number) => Number.isSafeInteger(number) && number >= 0) &&
    value.expectedGeometrySerial > 0
  )
}
