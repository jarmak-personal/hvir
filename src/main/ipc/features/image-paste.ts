import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type ImagePasteIpcDeps = Pick<IpcDeps, 'remoteImagePaste'>

export function registerImagePasteIpc(ipc: IpcRegistrar, deps: ImagePasteIpcDeps): void {
  ipc.handleSend('terminal:paste-image', (request, context) => {
    void deps.remoteImagePaste.pasteOrForward(
      request.id,
      context.owner(),
      request.fallbackData,
    )
  })
}
