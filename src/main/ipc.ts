/** Compose capability-specific IPC registrars behind one authority router. */

import { IpcAuthorityRouter, type IpcMainRegistrationPort } from './ipc/authority-router'
import type { IpcDeps } from './ipc/deps'
import { registerAppIpc } from './ipc/features/app'
import { registerFilesystemIpc } from './ipc/features/filesystem'
import { registerGitIpc } from './ipc/features/git'
import { registerHarnessIpc } from './ipc/features/harness'
import { registerPreviewIpc } from './ipc/features/preview'
import { registerProjectIpc } from './ipc/features/project'
import { registerTerminalIpc } from './ipc/features/terminal'
import { registerWebPaneIpc } from './ipc/features/web-pane'

export type { EmitRendererEvent, IpcDeps } from './ipc/deps'

export function registerIpcHandlers(
  deps: IpcDeps,
  transport?: IpcMainRegistrationPort,
): IpcAuthorityRouter {
  const router = new IpcAuthorityRouter(deps, transport)
  try {
    registerAppIpc(router, deps)
    registerProjectIpc(router, deps)
    registerFilesystemIpc(router, deps)
    registerGitIpc(router, deps)
    registerHarnessIpc(router, deps)
    registerPreviewIpc(router, deps)
    registerWebPaneIpc(router, deps)
    registerTerminalIpc(router, deps)
    router.assertComplete()
    return router
  } catch (error) {
    router.dispose()
    throw error
  }
}
