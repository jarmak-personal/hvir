import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ExtensionReply } from '../../shared/extensions/contract'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type { AdmittedExtensionContext, ExtensionContextOwner } from './context-owner'
import type { ExtensionGuestAuthority } from './guest-authority'
import type { ExtensionActivation } from './activation'

interface TargetView {
  view: ExtensionView
  readonly owner: RendererOwner
  readonly activation: ExtensionActivation
  readonly authority: ExtensionGuestAuthority
  readonly readingOrigin: 'human' | 'agent' | 'action'
  readonly selected: boolean
  readonly visible: boolean
  readonly requests: Map<string, AbortController>
  readonly actionRequests: ReadonlySet<string>
  readonly guestId?: number
  context?: AdmittedExtensionContext
  contextLease?: RendererResourceLease
}
/** Trusted human targeting changes context, never an admitted action or a permission. */
export function targetGuestWorkspace(
  record: TargetView,
  workspaceId: string | undefined,
  ports: {
    readonly contexts: ExtensionContextOwner
    readonly scopes: RendererResourceScopes
    readonly close: () => void
    readonly retireReads: () => void
    readonly send: (guest: number, reply: ExtensionReply) => void
  },
): void {
  const declaration = record.activation.revision.manifest.views.find(
    (view) => view.id === record.view.contributionId,
  )
  if (
    record.readingOrigin !== 'human' ||
    record.authority.restricted ||
    record.view.role !== 'view' ||
    !record.visible ||
    !record.selected ||
    declaration?.placement !== 'application'
  )
    throw new Error('Choose a project in a selected ordinary application view')
  if (record.actionRequests.size)
    throw new Error(
      'Wait for the current extension operation before changing its project',
    )
  const context = ports.contexts.admit(record.owner, {
    surface: record.context?.value.surface === 'top' ? 'top' : 'viewer',
    ...(workspaceId ? { workspaceId } : {}),
  })
  if (context.value.workspace?.id === record.context?.value.workspace?.id) return
  const lease = context.root
    ? ports.scopes.register(
        record.owner,
        {
          lifetime: 'workspace',
          type: 'extension-context',
          root: context.root,
          id: record.view.id,
        },
        ports.close,
      )
    : undefined
  for (const [id, controller] of record.requests) {
    controller.abort()
    if (record.guestId !== undefined)
      ports.send(record.guestId, {
        kind: 'result',
        id,
        ok: false,
        error: 'Project context changed; the previous request ended',
        warnings: [],
      })
  }
  // Retain admission until each physical request settles. Reusing an ID cannot let
  // an old finally handler release a newer request's accounting.
  ports.retireReads()
  record.contextLease?.release()
  record.contextLease = lease
  record.context = context
  record.view = { ...record.view, context: context.value }
}
