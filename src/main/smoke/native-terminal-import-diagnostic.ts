import type { BrowserWindow } from 'electron'
import { validNativeTerminalViewGrant } from '../../shared/native-terminal-presentation'

const PREFIX = 'HVIR_NATIVE_RECEIVER_STAGE '
const STAGES = new Set([
  'receiver-entry',
  'receiver-ineligible',
  'video-frame-acquired',
  'canvas-submitted',
  'frame-close-enter',
  'frame-close-return',
  'frame-close-rejected',
  'texture-release-enter',
  'texture-release-return',
  'texture-release-rejected',
])

/** Accept only the preload's closed diagnostic facts, never arbitrary console
 * text. The WebContents listener survives reload and preserves old-realm clocks. */
export function nativeReceiverDiagnosticLine(message: string): string | undefined {
  if (!message.startsWith(PREFIX) || message.length > 2048) return
  try {
    const parsed: unknown = JSON.parse(message.slice(PREFIX.length))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const value = parsed as Record<string, unknown>
    if (
      !value ||
      value.schema !== 1 ||
      typeof value.stage !== 'string' ||
      !STAGES.has(value.stage) ||
      value.clock !== 'renderer performance.now' ||
      ![value.event, value.resource].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
      ) ||
      ![value.atMs, value.timeOrigin].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
      ) ||
      typeof value.truncated !== 'boolean' ||
      typeof value.timelineDisabled !== 'boolean' ||
      !validNativeTerminalViewGrant(value.grant)
    )
      return
    const g = value.grant
    return (
      PREFIX +
      JSON.stringify({
        schema: 1,
        event: value.event,
        clock: value.clock,
        atMs: value.atMs,
        timeOrigin: value.timeOrigin,
        stage: value.stage,
        resource: value.resource,
        truncated: value.truncated,
        timelineDisabled: value.timelineDisabled,
        grant: {
          viewId: g.viewId,
          nativeEpoch: g.nativeEpoch,
          attachment: g.attachment,
          geometrySerial: g.geometrySerial,
          width: g.width,
          height: g.height,
          backingScale: g.backingScale,
        },
      })
    )
  } catch {
    return
  }
}

export function observeNativeReceiverDiagnostic(win: BrowserWindow): () => void {
  let count = 0
  const listener = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  ) => {
    if (count >= 8192) return
    const line = nativeReceiverDiagnosticLine(event.message)
    if (line) {
      count++
      console.log(line)
      if (count === 8192)
        console.log(
          'HVIR_NATIVE_RECEIVER_COLLECTION ' +
            JSON.stringify({ truncated: true, records: count }),
        )
    }
  }
  win.webContents.on('console-message', listener)
  return () => win.webContents.removeListener('console-message', listener)
}
