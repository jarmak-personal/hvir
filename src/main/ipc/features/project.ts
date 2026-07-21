import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type ProjectIpcDeps = Pick<
  IpcDeps,
  | 'getProjectState'
  | 'listHosts'
  | 'connectHost'
  | 'disconnectHost'
  | 'browseHost'
  | 'openProject'
  | 'switchWorkspace'
  | 'refreshProject'
  | 'updateWatchInterests'
  | 'closeProject'
  | 'pruneWorktrees'
  | 'dismissWorkspace'
  | 'acknowledgeWorkspace'
  | 'respondSshPrompt'
>

export function registerProjectIpc(ipc: IpcRegistrar, deps: ProjectIpcDeps): void {
  ipc.handle('project:root', () => deps.getProjectState())
  ipc.handle('project:hosts', () => deps.listHosts())
  ipc.handle('project:connect-host', (req, context) =>
    operationResult(() => deps.connectHost(req.hostId, context.owner())),
  )
  ipc.handle('project:disconnect-host', (req) =>
    operationResult(() => deps.disconnectHost(req.hostId)),
  )
  ipc.handle('project:browse-host', (req, context) =>
    operationResult(() => deps.browseHost(req.hostId, req.path, context.owner())),
  )
  ipc.handle('project:open', (req, context) =>
    operationResult(() => deps.openProject(req.hostId, req.path, context.owner())),
  )
  ipc.handle('project:switch', (req) =>
    operationResult(() => deps.switchWorkspace(req.projectId, req.workspaceId)),
  )
  ipc.handle('project:refresh', (req) =>
    operationResult(() => deps.refreshProject(req.projectId)),
  )
  ipc.handle('project:watch-interests', (req) =>
    operationResult(async () => {
      ipc.authority.assertActiveWorkspace(req.root)
      return deps.updateWatchInterests(req.paths)
    }),
  )
  ipc.handle('project:close', (req) =>
    operationResult(() => deps.closeProject(req.projectId)),
  )
  ipc.handle('workspace:prune', (req) =>
    operationResult(() => deps.pruneWorktrees(req.projectId)),
  )
  ipc.handle('workspace:dismiss', (req) =>
    operationResult(() => deps.dismissWorkspace(req.projectId, req.workspaceId)),
  )
  ipc.handle('workspace:acknowledge', (req) =>
    operationResult(() => deps.acknowledgeWorkspace(req.projectId, req.workspaceId)),
  )
  ipc.handle('ssh:prompt-response', (req, context) => {
    if (!Number.isSafeInteger(req?.id) || req.id <= 0) {
      throw new Error('Invalid SSH prompt id')
    }
    if (
      req.answers !== undefined &&
      (!Array.isArray(req.answers) ||
        req.answers.length > 16 ||
        req.answers.some(
          (answer) => typeof answer !== 'string' || answer.length > 16_384,
        ))
    ) {
      throw new Error('Invalid SSH prompt answers')
    }
    deps.respondSshPrompt(context.owner(), req.id, req.answers)
  })
}
