import type { ExtensionGuestPorts } from './guest-capability-ports'
import type { ExtensionActivation } from './activation'
import type { ExtensionInvocation } from '../../shared/extensions/contract'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ExtensionGuestAuthority } from './guest-authority'
import type { AdmittedExtensionContext } from './context-owner'
import type { RendererOwner } from '../renderer-resource-scopes'
interface SourceGuest {
  readonly owner: RendererOwner
  readonly activation: ExtensionActivation
  readonly view: ExtensionView
  readonly visible: boolean
  readonly readingOrigin: 'human' | 'agent' | 'action'
  readonly authority: ExtensionGuestAuthority
  readonly actions: ReadonlySet<string>
  readonly context?: AdmittedExtensionContext
}
/** Main-owned origin restrictions survive omitted invocation identities and view reuse. */
export async function requestGuestSource(
  capability: string,
  input: unknown,
  record: SourceGuest,
  signal: AbortSignal,
  assertOrigin: () => void,
  sources: ExtensionGuestPorts['sources'],
  invocation: ExtensionInvocation | undefined,
  reveal: ExtensionGuestPorts['sourceReveal'],
): Promise<unknown> {
  if (capability === 'source.status')
    return sources.approvals
      .status(record.activation)
      .map(({ root: _root, ...status }) => status)
  const caller = {
    activation: record.activation,
    view: record.view.id,
    signal,
    allowed:
      record.visible &&
      record.view.role !== 'updater' &&
      record.readingOrigin === 'human' &&
      !record.authority.restricted &&
      !invocation &&
      record.actions.size === 0,
    current: () => {
      assertOrigin()
      if (!record.visible) throw new Error('Selected source view is hidden')
    },
    context: () => record.context,
  }
  if (capability === 'source.reveal') {
    return reveal.reveal(caller, input, record.owner)
  }
  if (capability === 'source.select') return sources.select(caller, input)
  if (capability === 'source.render') return sources.render(caller, input)
  if (capability === 'source.asset') return sources.asset(caller, input)
  return sources.read(caller, input)
}
