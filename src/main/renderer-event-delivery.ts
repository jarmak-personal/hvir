import type { WebContents } from 'electron'

import type { IpcEventChannel, IpcEventPayload } from '../shared'

const DISPOSED_RENDER_FRAME_MESSAGE =
  'Render frame was disposed before WebFrameMain could be accessed'

export type RendererEventDeliveryFailure = 'disposed-frame'

/** Deliver one typed event while treating only Electron's disposed-frame race as stale. */
export function sendRendererEvent<E extends IpcEventChannel>(
  target: Pick<WebContents, 'send'>,
  channel: E,
  payload: IpcEventPayload<E>,
): void {
  try {
    target.send(channel, payload)
  } catch (error) {
    classifyRendererEventDeliveryFailure(error)
  }
}

/** Pure classification for the one Electron delivery failure that means the target is gone. */
export function classifyRendererEventDeliveryFailure(
  error: unknown,
): RendererEventDeliveryFailure {
  if (error instanceof Error && error.message === DISPOSED_RENDER_FRAME_MESSAGE) {
    return 'disposed-frame'
  }
  throw error
}
