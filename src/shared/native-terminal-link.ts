import type { HostPath } from './host-path'
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
