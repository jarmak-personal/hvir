import { hostPathEquals, type ReviewWorkspaceIdentity } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type DocumentReviewIpcDeps = Pick<
  IpcDeps,
  'documentReview' | 'documentReviewDelivery' | 'getProject' | 'getProjectState'
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

  ipc.handle('document-review:delivery-destinations', (request, context) =>
    operationResult(() => {
      requireDeliveryScope(ipc, deps, request.workspace)
      return Promise.resolve(
        deps.documentReviewDelivery.destinations(context.owner(), request),
      )
    }),
  )

  ipc.handle('document-review:prepare-delivery', (request, context) =>
    operationResult(() => {
      requireDeliveryScope(ipc, deps, request.workspace)
      if (!isBoundedId(request.terminalId)) throw new Error('Invalid review terminal')
      const selectionId =
        request.selection.kind === 'comment'
          ? request.selection.commentId
          : request.selection.batchId
      if (!isBoundedId(selectionId)) throw new Error('Invalid review selection')
      return Promise.resolve(
        deps.documentReviewDelivery.prepare(context.owner(), request),
      )
    }),
  )

  ipc.handle('document-review:insert-delivery', (request, context) =>
    operationResult(() => {
      if (!isBoundedId(request.preparedId)) {
        throw new Error('Invalid prepared review delivery')
      }
      return Promise.resolve(
        deps.documentReviewDelivery.insert(context.owner(), request.preparedId),
      )
    }),
  )
}

function requireDeliveryScope(
  ipc: IpcRegistrar,
  deps: DocumentReviewIpcDeps,
  workspace: ReviewWorkspaceIdentity,
): void {
  const root = ipc.authority.workspaceRoot(workspace.root)
  ipc.authority.assertActiveWorkspace(root)
  requireActiveWorkspace(deps, workspace, root)
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

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => character.codePointAt(0)! <= 31)
  )
}
