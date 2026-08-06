import { hostPathEquals, type ReviewWorkspaceIdentity } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type DocumentReviewIpcDeps = Pick<
  IpcDeps,
  'documentReview' | 'getProject' | 'getProjectState'
>

export function registerDocumentReviewIpc(
  ipc: IpcRegistrar,
  deps: DocumentReviewIpcDeps,
): void {
  ipc.handle('document-review:restore', (request, context) =>
    operationResult(async () => {
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      const project = requireActiveWorkspace(deps, request.workspace, root)
      return deps.documentReview.activate(
        context.owner(),
        request.workspace,
        project.host,
      )
    }),
  )

  ipc.handle('document-review:save', (request, context) =>
    operationResult(async () => {
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      requireActiveWorkspace(deps, request.workspace, root)
      return deps.documentReview.save(context.owner(), request)
    }),
  )

  ipc.handle('document-review:revalidate', (request, context) =>
    operationResult(async () => {
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      const project = requireActiveWorkspace(deps, request.workspace, root)
      const canonical = await ipc.authority.projectPath(
        request.document,
        project.root,
        project.host,
        { returnCanonical: true },
      )
      return deps.documentReview.revalidate(context.owner(), request, canonical)
    }),
  )
}

function requireActiveWorkspace(
  deps: DocumentReviewIpcDeps,
  workspace: ReviewWorkspaceIdentity,
  root: ReviewWorkspaceIdentity['root'],
) {
  const state = deps.getProjectState()
  const project = state.projects.find(
    (candidate) => candidate.id === state.activeProjectId,
  )
  const active = project?.workspaces.find(
    (candidate) => candidate.id === state.activeWorkspaceId,
  )
  if (!active || active.id !== workspace.id || !hostPathEquals(active.root, root)) {
    throw new Error('Document review belongs to another workspace identity')
  }
  return deps.getProject()
}
