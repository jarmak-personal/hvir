import { webFrameMain, type WebContents } from 'electron'

import { isWorkbenchDocument } from '../navigation-policy'

export interface RendererDocumentLifecycleHandlers {
  readonly started: () => void
  readonly committed: () => void
  readonly loaded: () => void
  readonly failed: (code: number, description: string, url: string) => void
}

/** Adapts generation-relevant main-frame navigation signals for one WebContents. */
export function installRendererDocumentLifecycle(
  contents: WebContents,
  entryUrl: string,
  handlers: RendererDocumentLifecycleHandlers,
): void {
  let pendingFrame: FrameIdentity | undefined
  contents.on(
    'did-start-navigation',
    (_event, url, isInPlace, isMainFrame, processId, frameId) => {
      if (
        isMainFrame &&
        !isInPlace &&
        isWorkbenchDocument(url, entryUrl) &&
        // A valid reload is provisional here, before `contents.mainFrame` flips.
        isLiveFrame(processId, frameId)
      ) {
        pendingFrame = { processId, routingId: frameId }
        handlers.started()
      }
    },
  )
  contents.on(
    'did-frame-navigate',
    (_event, url, _code, _status, isMainFrame, processId, frameId) => {
      if (
        isMainFrame &&
        isWorkbenchDocument(url, entryUrl) &&
        isCurrentMainFrame(contents, processId, frameId)
      ) {
        pendingFrame = undefined
        handlers.committed()
      }
    },
  )
  contents.on('did-frame-finish-load', (_event, isMainFrame, processId, frameId) => {
    if (isMainFrame && isCurrentMainFrame(contents, processId, frameId)) {
      handlers.loaded()
    }
  })
  contents.on(
    'did-fail-load',
    (_event, code, description, url, isMainFrame, processId, frameId) => {
      if (
        isMainFrame &&
        (isCurrentMainFrame(contents, processId, frameId) ||
          sameFrame(pendingFrame, processId, frameId))
      ) {
        pendingFrame = undefined
        handlers.failed(code, description, url)
      }
    },
  )
}

interface FrameIdentity {
  readonly processId: number
  readonly routingId: number
}

function isLiveFrame(processId: number, routingId: number): boolean {
  const frame = webFrameMain.fromId(processId, routingId)
  return Boolean(frame && !frame.detached)
}

function sameFrame(
  frame: FrameIdentity | undefined,
  processId: number,
  routingId: number,
): boolean {
  return frame?.processId === processId && frame.routingId === routingId
}

function isCurrentMainFrame(
  contents: WebContents,
  processId: number,
  routingId: number,
): boolean {
  const frame = contents.mainFrame
  return (
    !frame.isDestroyed() && frame.processId === processId && frame.routingId === routingId
  )
}
