/** Compose capability-specific IPC registrars behind one authority router. */

import { IpcAuthorityRouter, type IpcMainRegistrationPort } from './ipc/authority-router'
import type { IpcDeps } from './ipc/deps'
import { registerAppIpc } from './ipc/features/app'
import { registerClipboardIpc } from './ipc/features/clipboard'
import { registerDiagnosticReportIpc } from './ipc/features/diagnostic-report'
import { registerDocumentReviewIpc } from './ipc/features/document-review'
import { registerFilesystemIpc } from './ipc/features/filesystem'
import { registerGitIpc } from './ipc/features/git'
import { registerHarnessIpc } from './ipc/features/harness'
import { registerImagePasteIpc } from './ipc/features/image-paste'
import { registerPreviewIpc } from './ipc/features/preview'
import { registerProjectIpc } from './ipc/features/project'
import { registerSessionsIpc } from './ipc/features/sessions'
import { registerTerminalIpc } from './ipc/features/terminal'
import { registerTerminalFilePasteIpc } from './ipc/features/terminal-file-paste'
import { registerWebPaneIpc } from './ipc/features/web-pane'
import { ElectronClipboardFilePaste } from './terminal/electron-clipboard-file-paste'

export type { EmitRendererEvent, IpcDeps } from './ipc/deps'

export function registerIpcHandlers(
  deps: IpcDeps,
  transport?: IpcMainRegistrationPort,
): IpcAuthorityRouter {
  const router = new IpcAuthorityRouter(deps, transport)
  try {
    registerAppIpc(router, deps)
    registerDiagnosticReportIpc(router, deps)
    registerDocumentReviewIpc(router, deps)
    registerProjectIpc(router, deps)
    registerSessionsIpc(router, deps)
    registerFilesystemIpc(router, deps)
    registerGitIpc(router, deps)
    registerHarnessIpc(router, deps)
    registerImagePasteIpc(router, deps)
    registerClipboardIpc(router, deps)
    registerPreviewIpc(router, deps)
    registerWebPaneIpc(router, deps)
    registerTerminalIpc(router, deps)
    registerTerminalFilePasteIpc(router, new ElectronClipboardFilePaste())
    router.assertComplete()
    return router
  } catch (error) {
    router.dispose()
    throw error
  }
}
