import {
  hostPathEquals,
  type DocumentReviewDeliverySelection,
  type ReviewWorkspaceIdentity,
} from '../../../shared'
import { isDocumentReviewIdentifier } from '../../document-review/document-review-policy'
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
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      requireActiveWorkspace(deps, request.workspace, root)
      return Promise.resolve(
        deps.documentReviewDelivery.destinations(context.owner(), request),
      )
    }),
  )

  ipc.handle('document-review:preview-delivery', (request, context) =>
    operationResult(() => {
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      requireActiveWorkspace(deps, request.workspace, root)
      requireDeliverySelection(request.selection)
      return Promise.resolve(
        deps.documentReviewDelivery.preview(context.owner(), request),
      )
    }),
  )

  ipc.handle('document-review:prepare-delivery', (request, context) =>
    operationResult(() => {
      const root = ipc.authority.workspaceRoot(request.workspace.root)
      ipc.authority.assertActiveWorkspace(root)
      requireActiveWorkspace(deps, request.workspace, root)
      if (!isDocumentReviewIdentifier(request.terminalId)) {
        throw new Error('Invalid review terminal')
      }
      requireDeliverySelection(request.selection)
      return Promise.resolve(
        deps.documentReviewDelivery.prepare(context.owner(), request),
      )
    }),
  )

  ipc.handle('document-review:insert-delivery', (request, context) =>
    operationResult(() => {
      if (!isDocumentReviewIdentifier(request.preparedId)) {
        throw new Error('Invalid prepared review delivery')
      }
      return Promise.resolve(
        deps.documentReviewDelivery.insert(context.owner(), request.preparedId),
      )
    }),
  )

  ipc.handle('document-review:send-now-delivery', (request, context) =>
    operationResult(() => {
      if (!isDocumentReviewIdentifier(request.preparedId)) {
        throw new Error('Invalid prepared review delivery')
      }
      return deps.documentReviewDelivery.sendNow(context.owner(), request.preparedId)
    }),
  )
}

function requireDeliverySelection(selection: DocumentReviewDeliverySelection): void {
  const id = selection.kind === 'comment' ? selection.commentId : selection.batchId
  if (!isDocumentReviewIdentifier(id)) throw new Error('Invalid review selection')
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
