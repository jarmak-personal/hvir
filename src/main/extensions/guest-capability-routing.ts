import { requestGuestConnector } from './guest-connectors'
import { requestGuestSource } from './guest-sources'
import { extensionId, extensionObject } from '../../shared/extensions/manifest'
import type { ExtensionGuestPorts } from './guest-capability-ports'
import type { ExtensionActivation } from './activation'
import type { ExtensionGuestAuthority } from './guest-authority'
import type { ExtensionContextOwner, AdmittedExtensionContext } from './context-owner'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type {
  ExtensionContext,
  ExtensionInvocation,
  ExtensionPresentation,
} from '../../shared/extensions/contract'

interface GuestCapabilityCaller {
  readonly authority: ExtensionGuestAuthority
  readonly activation: ExtensionActivation
  readonly view: ExtensionView
  readonly owner: RendererOwner
  readonly context?: AdmittedExtensionContext
  readonly presentation: ExtensionPresentation
  readonly visible: boolean
  readonly refreshDemand: boolean
  readonly readingOrigin: 'human' | 'agent' | 'action'
  readonly actions: ReadonlySet<string>
}

/** Routes already-admitted requests; guest lifetime and context bounds stay with the caller. */
export async function routeGuestCapability(
  ports: ExtensionGuestPorts,
  contexts: ExtensionContextOwner,
  record: GuestCapabilityCaller,
  capability: string,
  input: unknown,
  signal: AbortSignal,
  assertOrigin: () => void,
  contextValue: () => ExtensionContext,
  openOwnView: (
    input: unknown,
    current: () => void,
    invocation?: ExtensionInvocation,
  ) => Promise<unknown>,
  invocation: ExtensionInvocation | undefined,
  foreground: () => boolean,
): Promise<unknown> {
  if (capability === 'terminal.start') {
    if (!ports.terminals) throw new Error('Terminal handoff is unavailable')
    return ports.terminals.start(
      { ...record, view: record.view.id },
      input,
      invocation,
      assertOrigin,
      signal,
    )
  }
  if (capability.startsWith('connector.') || capability.startsWith('delivery.'))
    return requestGuestConnector(
      capability,
      input,
      record,
      signal,
      assertOrigin,
      contexts,
      ports.connectors,
      ports.connections,
      ports.actions,
      ports.connectorDemand,
      invocation,
      ports.deliveries,
      foreground,
    )
  if (capability.startsWith('source.'))
    return requestGuestSource(
      capability,
      input,
      record,
      signal,
      assertOrigin,
      ports.sources,
      invocation,
      ports.sourceReveal,
    )
  if (capability === 'presentation.read') return record.presentation
  if (capability === 'context.read') return contextValue()
  if (capability === 'contributions.read') {
    return ports.presentationState.values(record.activation)
  }
  if (capability === 'contributions.publish') {
    await ports.presentationState.publish(
      record.activation,
      input,
      () =>
        (record.view.role === 'updater'
          ? ports.updaterSessions(record.activation.installationId)
          : contexts
              .sessions(record.owner)
              .filter((session) =>
                record.context?.value.session
                  ? session.id === record.context.value.session.id
                  : session.workspace.id === record.context?.value.workspace?.id,
              )
        ).map((session) => session.id),
      () => {
        assertOrigin()
        if (!record.visible && !ports.actions.provenance(record.view.id, invocation?.id))
          throw new Error('Presentation refresh demand ended')
      },
      signal,
    )
    return null
  }
  if (capability === 'actions.invoke') {
    const target = extensionObject(input)
    const action = extensionId(target['action'])
    const authority =
      record.authority.forAction(action) ??
      (invocation
        ? ports.actions.authority(record.view.id, invocation.id)?.forAction?.(action)
        : undefined)
    const declaration = record.activation.revision.manifest.actions?.find(
      (action) => action.id === target['action'],
    )
    const authorization =
      authority?.authorizeAction && declaration
        ? await authority.authorizeAction(
            {
              title: declaration.title,
              input: JSON.stringify(target['input'] ?? null),
              effects: declaration.effects,
            },
            assertOrigin,
            signal,
          )
        : (invocation?.authorization ?? 'unapproved')
    assertOrigin()
    return ports.actions.invoke(
      record.owner,
      record.activation,
      extensionId(target['action']),
      target['input'],
      {
        surface: 'viewer',
        ...(record.context?.value.workspace
          ? { workspaceId: record.context.value.workspace.id }
          : {}),
        ...(record.context?.value.session
          ? { sessionId: record.context.value.session.id }
          : {}),
      },
      invocation?.caller ?? (record.authority.restricted ? 'agent' : 'guest'),
      authorization,
      assertOrigin,
      signal,
      authority,
    )
  }
  if (capability === 'viewer.open-own')
    return openOwnView(input, assertOrigin, invocation)
  throw new Error('Unknown extension capability')
}
