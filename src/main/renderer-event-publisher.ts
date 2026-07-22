import { BrowserWindow } from 'electron'

import type { IpcEventChannel, IpcEventPayload } from '../shared'
import type { RendererOwner, RendererResourceScopes } from './renderer-resource-scopes'

/** Generation-aware Electron delivery edge for typed main-to-renderer events. */
export class RendererEventPublisher {
  constructor(private readonly scopes: Pick<RendererResourceScopes, 'isCurrent'>) {}

  readonly toWindows = <E extends IpcEventChannel>(
    channel: E,
    payload: IpcEventPayload<E>,
  ): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  readonly toRenderer = <E extends IpcEventChannel>(
    owner: RendererOwner,
    channel: E,
    payload: IpcEventPayload<E>,
  ): void => {
    if (!this.scopes.isCurrent(owner)) return
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === owner.id,
    )
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
