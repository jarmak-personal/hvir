import type { NativeTerminalStatus } from '../../shared/native-terminal'
import { NATIVE_TERMINAL_LIMITS as limits } from '../../shared/native-terminal'
import { validNativeTerminalScale } from '../../shared/native-terminal-presentation'

export function validNativeTerminalStatus(value: unknown): value is NativeTerminalStatus {
  const v = value as NativeTerminalStatus | undefined
  if (!v || !v.geometry || typeof v.closing !== 'boolean') return false
  const g = v.geometry
  const unsigned = [
    v.appliedSequence,
    v.ioAppliedSequence,
    v.ioAppliedMutation,
    v.inputFailure,
    v.replySequence,
    v.queuedReplyBytes,
    v.failure,
    v.rendererHealth,
    v.presentationFailure,
    v.frameCopies,
    v.geometryFailureSerial,
    v.appliedAppearanceSerial,
    v.appearanceFailureSerial,
    g.serial,
    g.columns,
    g.rows,
    g.width,
    g.height,
    g.cellWidth,
    g.cellHeight,
    g.contentWidth,
    g.contentHeight,
    g.paddingLeft,
    g.paddingTop,
  ]
  return (
    unsigned.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    validNativeTerminalScale(g.backingScale) &&
    v.queuedReplyBytes <= limits.responseBytes &&
    g.serial > 0 &&
    g.width > 0 &&
    g.width <= 8192 &&
    g.height > 0 &&
    g.height <= 8192 &&
    g.columns > 0 &&
    g.rows > 0 &&
    g.cellWidth > 0 &&
    g.cellHeight > 0 &&
    g.contentWidth + g.paddingLeft <= g.width &&
    g.contentHeight + g.paddingTop <= g.height
  )
}
