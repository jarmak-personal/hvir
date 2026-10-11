import type { ExtensionGuestPorts } from './guest-capability-ports'
import { extensionId, extensionObject } from '../../shared/extensions/validation'
import { validateExtensionViewInput } from '../../shared/extensions/view-input'
import type {
  ExtensionSurfaceRequest,
  ExtensionView,
} from '../../shared/extensions/workbench'
import type { ExtensionInvocation } from '../../shared/extensions/contract'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionGuestAuthority, ExtensionViewAuthority } from './guest-authority'
import type { AdmittedExtensionContext } from './context-owner'
interface OwnViewCaller {
  readonly owner: RendererOwner
  readonly view: ExtensionView
  readonly authority: ExtensionGuestAuthority
  readonly readingOrigin: 'human' | 'agent' | 'action'
  readonly context?: AdmittedExtensionContext
  readonly activation: {
    readonly installationId: string
    readonly revision: {
      readonly manifest: {
        readonly views: readonly { readonly id: string; readonly placement: string }[]
      }
    }
  }
}
interface OwnViewPort {
  open(
    owner: RendererOwner,
    installation: string,
    contribution: string,
    admit: () => void,
    options: {
      focus: boolean
      input?: unknown
      readingOrigin: 'human' | 'agent' | 'action'
      authority?: ExtensionViewAuthority
      context: ExtensionSurfaceRequest
    },
  ): Promise<ExtensionView>
}
/** Opening own UI transports data and preserves main origin; it grants no source access. */
export async function openGuestOwnView(
  port: OwnViewPort,
  record: OwnViewCaller,
  input: unknown,
  current: () => void,
  actions: ExtensionGuestPorts['actions'],
  invocation?: ExtensionInvocation,
): Promise<unknown> {
  const target = extensionObject(input)
  const contribution = extensionId(target['contributionId'])
  if (target['context'] !== undefined && target['context'] !== 'application')
    throw new Error('Unsupported own-view context')
  const application = target['context'] === 'application'
  if (
    application &&
    record.activation.revision.manifest.views.find((entry) => entry.id === contribution)
      ?.placement !== 'application'
  )
    throw new Error('Only application contributions can omit workspace context')
  const opened = await port.open(
    record.owner,
    record.activation.installationId,
    contribution,
    current,
    {
      focus: !invocation,
      input: validateExtensionViewInput(target['input']),
      readingOrigin: invocation ? 'action' : record.readingOrigin,
      authority:
        record.authority.view() ??
        (invocation ? actions.authority(record.view.id, invocation.id)?.view : undefined),
      context: {
        surface: 'viewer',
        ...(!application && record.context?.value.workspace
          ? { workspaceId: record.context.value.workspace.id }
          : {}),
        ...(!application && record.context?.value.session
          ? { sessionId: record.context.value.session.id }
          : {}),
      },
    },
  )
  return { viewId: opened.id }
}
