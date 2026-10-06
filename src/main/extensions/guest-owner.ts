import { parseGuestAppearance } from './guest-appearance'
import type { ExtensionGuestPorts } from './guest-capability-ports'
import { routeGuestCapability } from './guest-capability-routing'
import { extensionRequestDeadline } from '../../shared/extensions/request-deadline'
import { openGuestOwnView } from './guest-view-opening'
import { validateExtensionViewInput } from '../../shared/extensions/view-input'
import { PRESENTATION_COLOR_DEFAULTS } from '../../shared/presentation/tokens'
import {
  SYSTEM_INTERFACE_FONT_STACK,
  SYSTEM_MONOSPACE_FONT_STACK,
} from '../../shared/interface-typography'
import { randomUUID } from 'node:crypto'
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CONTRACT,
  EXTENSION_LIMITS,
  type ExtensionPresentation,
  type ExtensionReply,
  type ExtensionInvocation,
  type ExtensionContext,
} from '../../shared/extensions/contract'
import {
  extensionObject,
  extensionText,
  unknownExtensionFields,
} from '../../shared/extensions/manifest'
import type {
  ExtensionSurfaceRequest,
  ExtensionView,
} from '../../shared/extensions/workbench'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type { ExtensionActivationOwner, ExtensionActivation } from './activation'
import {
  boundedExtensionSessions,
  boundedExtensionContext,
  type ExtensionContextOwner,
  type AdmittedExtensionContext,
} from './context-owner'
import type { ExtensionRevision } from './package-store'
import { ExtensionGuestAuthority, type ExtensionViewAuthority } from './guest-authority'

export interface ExtensionGuestSurfacePort {
  prepare(view: ExtensionView, revision: ExtensionRevision): Promise<void>
  destroy(viewId: string): Promise<void>
  send(guestId: number, reply: ExtensionReply): void
  visibility(guestId: number, visible: boolean): void
  foreground(owner: RendererOwner): boolean
  runnable?(guestId: number, admitted: boolean): void
}

interface GuestRecord {
  readonly authority: ExtensionGuestAuthority
  view: ExtensionView
  readonly owner: RendererOwner
  readonly activation: ExtensionActivation
  readonly requests: Map<string, AbortController>
  presentation: ExtensionPresentation
  guestId?: number
  ready: boolean
  claimed: boolean
  negotiated: boolean
  visible: boolean
  refreshDemand: boolean
  rateStart: number
  messages: number
  disposal?: Promise<void>
  context?: AdmittedExtensionContext
  contextLease?: RendererResourceLease
  readonly actions: Set<string>
  sentContext?: ExtensionContext
  initialInput?: unknown
  readonly readingOrigin: 'human' | 'agent' | 'action'
}

export const DEFAULT_EXTENSION_PRESENTATION: ExtensionPresentation = {
  appearance: 'dark',
  colors: PRESENTATION_COLOR_DEFAULTS,
  fontFamily: SYSTEM_INTERFACE_FONT_STACK,
  monospaceFontFamily: SYSTEM_MONOSPACE_FONT_STACK,
  interfaceScale: 1,
  width: 0,
  height: 0,
}

/** Admission, caller provenance, capability and revocation policy, independent of Electron. */
export class ExtensionGuestOwner {
  private readonly records = new Map<string, GuestRecord>()
  private readonly rendererLeases = new Map<string, RendererResourceLease>()
  private readonly closing = new Set<GuestRecord>()
  private disposed = false

  constructor(
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable'
    >,
    private readonly scopes: RendererResourceScopes,
    private readonly surface: ExtensionGuestSurfacePort,
    private readonly publish: (
      owner: RendererOwner,
      views: readonly ExtensionView[],
      selectedId?: string,
      focus?: boolean,
    ) => void,
    readonly contexts: ExtensionContextOwner,
    private readonly ports: ExtensionGuestPorts,
  ) {
    if (!contexts) throw new Error('Extension context admission is unavailable')
  }

  snapshot(owner: RendererOwner): readonly ExtensionView[] {
    return [...this.records.values()]
      .filter((record) => record.ready && sameOwner(record.owner, owner))
      .map((record) => record.view)
  }

  async open(
    owner: RendererOwner,
    installationId: string,
    contributionId: string,
    admit: () => void = () => undefined,
    options: {
      context?: ExtensionSurfaceRequest
      focus?: boolean
      select?: boolean
      updater?: boolean
      authority?: ExtensionViewAuthority
      input?: unknown
      readingOrigin?: 'human' | 'agent' | 'action'
    } = {},
  ): Promise<ExtensionView> {
    this.scopes.assertCurrent(owner)
    await this.activations.assertWritable()
    admit()
    const activation = this.activations.active.get(installationId)
    const contribution =
      options.updater && activation?.revision.manifest.updater
        ? {
            id: 'updater',
            title: `${activation.revision.manifest.name} updates`,
            entry: activation.revision.manifest.updater,
          }
        : activation?.revision.manifest.views.find((entry) => entry.id === contributionId)
    if (!activation || !contribution || this.disposed)
      throw new Error('Enable this extension before opening its declared view')
    const context = options.updater
      ? undefined
      : this.contexts.admit(owner, options.context ?? { surface: 'viewer' })
    if (
      contribution &&
      'placement' in contribution &&
      contribution.placement === 'workspace' &&
      !context?.value.workspace
    )
      throw new Error('This view needs an admitted workspace context')
    const matching = [...this.records.values()].filter(
      (entry) =>
        sameOwner(entry.owner, owner) &&
        entry.activation === activation &&
        entry.view.contributionId === contributionId &&
        entry.view.role === (options.updater ? 'updater' : 'view') &&
        entry.context?.value.workspace?.id === context?.value.workspace?.id &&
        entry.context?.value.session?.id === context?.value.session?.id &&
        entry.context?.value.surface === context?.value.surface,
    )
    // Preserve the established restricted-origin refusal before separating human body caches.
    for (const record of matching) record.authority.assertReuse(options.authority)
    const human = (options.readingOrigin ?? 'human') === 'human'
    const existing = matching.find(
      (record) => (record.readingOrigin === 'human') === human,
    )
    if (existing) {
      if (!existing.ready || existing.view.failure)
        throw new Error(
          'This view is opening or stopped; close it before opening it again',
        )
      existing.authority.assertReuse(options.authority)
      existing.authority.add(options.authority, () => this.closeRecord(existing))
      if (options.input !== undefined) {
        existing.initialInput = validateExtensionViewInput(options.input)
        this.ports.sources.closeView(existing.view.id)
        this.sendContext(existing)
      }
      this.publish(
        owner,
        this.snapshot(owner),
        options.updater || options.select === false ? undefined : existing.view.id,
        options.focus,
      )
      return existing.view
    }
    if (
      this.records.size >= EXTENSION_LIMITS.views ||
      [...this.records.values()].filter(
        (entry) => entry.activation.installationId === installationId,
      ).length >= EXTENSION_LIMITS.viewsPerExtension
    )
      throw new Error('Close an extension view before opening another')
    const id = randomUUID()
    const view: ExtensionView = {
      id,
      installationId,
      contributionId,
      extensionName: activation.revision.manifest.name,
      title: contribution.title,
      partition: `hvir-extension-${id}`,
      url: `hvir-extension://${id}/${contribution.entry}`,
      role: options.updater ? 'updater' : 'view',
      ...(context ? { context: context.value } : {}),
    }
    const record: GuestRecord = {
      authority: new ExtensionGuestAuthority(),
      view,
      owner,
      activation,
      requests: new Map(),
      presentation: DEFAULT_EXTENSION_PRESENTATION,
      ready: false,
      claimed: false,
      negotiated: false,
      visible: false,
      refreshDemand: false,
      rateStart: performance.now(),
      messages: 0,
      context,
      actions: new Set(),
      initialInput: validateExtensionViewInput(options.input),
      readingOrigin: options.readingOrigin ?? 'human',
    }
    record.authority.add(options.authority, () => this.closeRecord(record))
    this.records.set(id, record)
    if (!record.authority.current()) {
      this.closeRecord(record)
      throw new Error('Extension forward origin was revoked')
    }
    if (context?.root)
      record.contextLease = this.scopes.register(
        owner,
        { lifetime: 'workspace', type: 'extension-context', root: context.root, id },
        () => this.close(owner, id),
      )
    const key = ownerKey(owner)
    if (!this.rendererLeases.has(key)) {
      this.rendererLeases.set(
        key,
        this.scopes.register(
          owner,
          { lifetime: 'renderer', type: 'extension-views' },
          () => this.closeOwner(owner),
        ),
      )
    }
    try {
      await this.surface.prepare(view, activation.revision)
      await this.activations.assertWritable()
      this.assertRecord(record)
      admit()
      record.ready = true
      this.publish(
        owner,
        this.snapshot(owner),
        options.updater || options.select === false ? undefined : view.id,
        options.focus,
      )
      return view
    } catch (reason) {
      this.closeRecord(record)
      throw reason
    }
  }

  claim(
    owner: RendererOwner,
    partition: string,
    url: string,
    name: string,
  ): ExtensionView | undefined {
    const record = [...this.records.values()].find(
      (entry) =>
        sameOwner(entry.owner, owner) &&
        entry.view.partition === partition &&
        entry.view.url === url &&
        entry.view.id === name,
    )
    if (!record || !record.ready || record.claimed || !this.current(record))
      return undefined
    record.claimed = true
    return record.view
  }

  bind(
    owner: RendererOwner,
    partition: string,
    guestId: number,
  ): ExtensionView | undefined {
    const record = [...this.records.values()].find(
      (entry) => sameOwner(entry.owner, owner) && entry.view.partition === partition,
    )
    if (
      !record ||
      !record.claimed ||
      record.guestId !== undefined ||
      !this.current(record)
    )
      return undefined
    record.guestId = guestId
    this.surface.visibility(guestId, record.visible)
    this.surface.runnable?.(guestId, record.actions.size > 0)
    return record.view
  }

  close(owner: RendererOwner, viewId: string): Promise<void> {
    const record = this.records.get(viewId)
    if (!record || !sameOwner(record.owner, owner))
      return (
        [...this.closing].find(
          (entry) => entry.view.id === viewId && sameOwner(entry.owner, owner),
        )?.disposal ?? Promise.resolve()
      )
    this.closeRecord(record)
    return record.disposal!
  }

  revokeInstallation(installationId: string): void {
    for (const record of [...this.records.values()])
      if (record.activation.installationId === installationId) this.closeRecord(record)
  }

  closeOwner(owner: RendererOwner): Promise<void> {
    for (const record of [...this.records.values()])
      if (sameOwner(record.owner, owner)) this.closeRecord(record)
    this.rendererLeases.get(ownerKey(owner))?.release()
    this.rendererLeases.delete(ownerKey(owner))
    return this.awaitDisposals(
      [...this.closing].filter((record) => sameOwner(record.owner, owner)),
    )
  }

  failed(guestId: number, explanation?: string): void {
    const record = this.byGuest(guestId)
    if (!record) return
    this.ports.actions.revokeView(record.view.id)
    record.view = {
      ...record.view,
      failure:
        explanation ??
        'This extension view stopped. Close it and open it again from Settings.',
    }
    if (record.view.role === 'updater') this.ports.updaterFailed(record.view)
    else this.ports.visibleContributionsChanged()
    for (const controller of record.requests.values()) controller.abort()
    record.requests.clear()
    record.guestId = undefined
    this.destroySurface(record)
    this.publish(record.owner, this.snapshot(record.owner))
  }

  presentation(
    owner: RendererOwner,
    viewId: string,
    value: ExtensionPresentation,
    visible: boolean,
    refreshDemand: boolean,
  ): void {
    const record = this.records.get(viewId)
    if (!record || !sameOwner(record.owner, owner) || !this.current(record)) return
    const previousDemand = record.refreshDemand
    // Visibility authority is independent of parsing the latest appearance snapshot.
    record.visible =
      record.view.role === 'updater'
        ? record.visible
        : visible === true &&
          (!this.foregroundPlacement(record) || this.ownerForeground(owner))
    record.refreshDemand =
      record.visible && refreshDemand === true && this.ownerForeground(owner)
    this.ports.connections.revalidate()
    this.ports.connectors.revalidate()
    this.ports.sources.revalidate()
    if (record.refreshDemand !== previousDemand) this.ports.visibleContributionsChanged()
    if (record.guestId !== undefined)
      this.surface.visibility(record.guestId, record.visible)
    record.presentation = parseGuestAppearance(value)
    this.sendContext(record)
    this.sendValues(record)
    if (record.guestId !== undefined) {
      if (record.negotiated && record.visible)
        this.surface.send(record.guestId, {
          kind: 'presentation',
          presentation: record.presentation,
        })
    }
  }

  ownerForeground(owner: RendererOwner): boolean {
    return this.scopes.isCurrent(owner) && this.surface.foreground(owner)
  }
  /** Physical background withdrawal precedes any renderer publication. */
  foregroundChanged(owner: RendererOwner): void {
    if (this.ownerForeground(owner)) return
    for (const record of this.records.values()) {
      if (
        !this.current(record) ||
        (!sameOwner(record.owner, owner) && record.view.role !== 'updater')
      )
        continue
      record.refreshDemand = false
      if (
        this.foregroundPlacement(record) ||
        (record.view.role === 'updater' &&
          !this.ports.connectorDemand(record.activation.installationId))
      )
        record.visible = false
      if (record.guestId !== undefined)
        this.surface.visibility(record.guestId, record.visible)
      this.sendContext(record)
    }
    this.ports.connections.revalidate()
    this.ports.connectors.revalidate()
    this.ports.sources.revalidate()
    this.ports.visibleContributionsChanged()
  }
  private foregroundPlacement(record: GuestRecord): boolean {
    return (
      record.view.context?.surface === 'top' || record.view.context?.surface === 'left'
    )
  }

  /** A fixed isolated-preload signal invalidates state, never supplies visibility authority. */
  nativeVisibilityChanged(guestId: number): void {
    const record = this.byGuest(guestId)
    if (record && this.current(record) && !record.visible)
      this.surface.visibility(guestId, false)
  }

  receive(guestId: number, value: unknown): void {
    const record = this.byGuest(guestId)
    if (!record || !this.current(record)) return
    let id: string | undefined
    let warnings: readonly string[] = []
    try {
      if (
        Buffer.byteLength(JSON.stringify(value), 'utf8') > EXTENSION_LIMITS.messageBytes
      )
        throw new Error('Extension message exceeds its byte limit')
      const now = performance.now()
      if (now - record.rateStart >= 1000) {
        record.rateStart = now
        record.messages = 0
      }
      if (++record.messages > EXTENSION_LIMITS.messagesPerSecond) {
        this.failed(guestId)
        return
      }
      const message = extensionObject(value)
      if (message['kind'] === 'action-result') {
        if (
          !record.negotiated ||
          typeof message['id'] !== 'string' ||
          !this.ports.actions.provenance(record.view.id, message['id'])
        )
          return
        this.ports.actions.result(
          record.view.id,
          extensionText(message['id'], 'action identity', 80),
          message['value'],
          message['error'] as string | undefined,
        )
        return
      }
      if (message['kind'] === 'hello') {
        if (
          record.negotiated ||
          message['contract'] !== record.activation.revision.manifest.contract
        )
          throw new Error(
            `Negotiate extension contract ${record.activation.revision.manifest.contract} once before requesting capabilities`,
          )
        record.negotiated = true
        warnings = unknownExtensionFields(message, ['kind', 'contract'])
        this.surface.send(guestId, {
          kind: 'hello',
          contract: EXTENSION_CONTRACT,
          capabilities: this.admittedCapabilities(record),
          presentation: record.presentation,
          warnings,
        })
        this.sendContext(record)
        this.sendValues(record)
        this.ports.actions.ready(record.view.id)
        return
      }
      id = extensionText(message['id'], 'request identity', 80)
      if (!/^[a-zA-Z0-9-]+$/u.test(id)) throw new Error('Invalid request identity')
      if (message['kind'] === 'cancel') {
        record.requests.get(id)?.abort()
        return
      }
      warnings = unknownExtensionFields(message, [
        'kind',
        'id',
        'capability',
        'input',
        'actionId',
      ])
      if (message['kind'] !== 'request' || !record.negotiated)
        throw new Error('Negotiate before requesting a capability')
      const capability = extensionText(message['capability'], 'capability', 80)
      if (!this.admittedCapabilities(record).includes(capability))
        throw new Error(
          `Extension contract ${record.activation.revision.manifest.contract}: capability ${capability} is unavailable or undeclared`,
        )
      const invocation = this.ports.actions.provenance(
        record.view.id,
        message['actionId'],
      )
      if (
        (!record.visible ||
          (this.foregroundPlacement(record) && !this.ownerForeground(record.owner))) &&
        !invocation
      )
        throw new Error(
          'Hidden extension views cannot request refresh or open another view',
        )
      const pending = [...this.records.values()].reduce(
        (sum, entry) => sum + entry.requests.size,
        0,
      )
      const extensionPending = [...this.records.values()]
        .filter((entry) => entry.activation === record.activation)
        .reduce((sum, entry) => sum + entry.requests.size, 0)
      if (
        record.requests.has(id) ||
        record.requests.size >= EXTENSION_LIMITS.requestsPerView ||
        extensionPending >= EXTENSION_LIMITS.requestsPerExtension ||
        pending >= EXTENSION_LIMITS.requests
      )
        throw new Error('Extension request capacity is full')
      if (capability === 'viewer.open-own')
        warnings = [
          ...warnings,
          ...unknownExtensionFields(extensionObject(message['input']), [
            'contributionId',
            'input',
            'context',
          ]),
        ].slice(0, EXTENSION_LIMITS.warnings)
      const controller = new AbortController()
      record.requests.set(id, controller)
      const timer = setTimeout(
        () => controller.abort(),
        extensionRequestDeadline(capability),
      )
      void this.request(
        record,
        capability,
        message['input'],
        controller.signal,
        invocation,
      )
        .then(
          (result) => {
            if (!controller.signal.aborted && this.current(record))
              this.surface.send(guestId, {
                kind: 'result',
                id: id!,
                ok: true,
                value: result,
                warnings,
              })
          },
          (reason: unknown) => {
            if (!controller.signal.aborted && this.current(record))
              this.surface.send(guestId, {
                kind: 'result',
                id: id!,
                ok: false,
                error: errorText(reason),
                warnings,
              })
          },
        )
        .finally(() => {
          clearTimeout(timer)
          record.requests.delete(id!)
        })
    } catch (reason) {
      if (!id)
        this.failed(
          guestId,
          `Extension contract ${record.activation.revision.manifest.contract}: ${errorText(reason)}`,
        )
      if (id && this.current(record))
        this.surface.send(guestId, {
          kind: 'result',
          id,
          ok: false,
          error: errorText(reason),
          warnings,
        })
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    for (const record of [...this.records.values()]) this.closeRecord(record)
    for (const lease of this.rendererLeases.values()) lease.release()
    this.rendererLeases.clear()
    return this.awaitDisposals(this.closing)
  }

  private async request(
    record: GuestRecord,
    capability: string,
    input: unknown,
    signal: AbortSignal,
    invocation?: ExtensionInvocation,
  ): Promise<unknown> {
    await this.activations.assertWritable()
    const invocationAuthority = invocation
      ? this.ports.actions.authority(record.view.id, invocation.id)
      : undefined
    if (invocationAuthority?.signal)
      signal = AbortSignal.any([signal, invocationAuthority.signal])
    const assertOrigin = (): void => {
      this.assertRecord(record)
      signal.throwIfAborted()
      if (
        !invocation &&
        this.foregroundPlacement(record) &&
        !this.ownerForeground(record.owner)
      )
        throw new Error('Selected extension window is in the background')
      if (invocation && !this.ports.actions.provenance(record.view.id, invocation.id))
        throw new Error('Originating action was revoked')
    }
    assertOrigin()
    const result = await routeGuestCapability(
      this.ports,
      this.contexts,
      record,
      capability,
      input,
      signal,
      assertOrigin,
      () => this.contextValue(record),
      (input, current, invocation) =>
        openGuestOwnView(this, record, input, current, this.ports.actions, invocation),
      invocation,
      () => this.ownerForeground(record.owner),
    )
    assertOrigin()
    return result
  }

  visibleViewContributions(): readonly { owner: RendererOwner; view: ExtensionView }[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.visible &&
          record.refreshDemand &&
          record.view.role !== 'updater' &&
          record.view.context?.surface === 'viewer' &&
          !record.view.failure &&
          this.current(record),
      )
      .map((record) => ({ owner: record.owner, view: record.view }))
  }

  assertOwner(owner: RendererOwner): void {
    this.scopes.assertCurrent(owner)
  }
  assertView(viewId: string): void {
    const record = this.records.get(viewId)
    if (!record) throw new Error('Extension view is unavailable')
    this.assertRecord(record)
  }
  dispatch(viewId: string, invocation: ExtensionInvocation): boolean {
    const record = this.records.get(viewId)
    if (record?.negotiated && record.guestId !== undefined && this.current(record)) {
      this.surface.send(record.guestId, {
        kind: 'action',
        invocation: { ...invocation, context: this.contextValue(record) },
      })
      return true
    }
    return false
  }
  cancelAction(viewId: string, id: string): void {
    const record = this.records.get(viewId)
    if (record?.guestId !== undefined)
      this.surface.send(record.guestId, { kind: 'action-cancelled', id })
  }
  runnable(viewId: string, id: string, admitted: boolean): void {
    const record = this.records.get(viewId)
    if (!record) return
    if (admitted) record.actions.add(id)
    else record.actions.delete(id)
    if (record.guestId !== undefined)
      this.surface.runnable?.(record.guestId, record.actions.size > 0)
  }
  updateContext(): void {
    this.ports.connections.revalidate()
    this.ports.connectors.revalidate()
    this.ports.sources.revalidate()
    for (const record of [...this.records.values()]) {
      if (!this.current(record)) this.closeRecord(record)
      else this.sendContext(record)
    }
  }
  publishValues(): void {
    for (const record of this.records.values()) this.sendValues(record)
  }
  private sendValues(record: GuestRecord): void {
    if (
      record.visible &&
      record.negotiated &&
      record.guestId !== undefined &&
      this.current(record) &&
      this.admittedCapabilities(record).includes('contributions.read')
    )
      this.surface.send(record.guestId, {
        kind: 'contributions',
        values: this.ports.presentationState.values(record.activation),
      })
  }
  updaterDemand(owner: RendererOwner, viewId: string, demanded: boolean): void {
    const record = this.records.get(viewId)
    if (
      !record ||
      !sameOwner(record.owner, owner) ||
      record.view.role !== 'updater' ||
      !this.current(record)
    )
      return
    record.visible = demanded
    this.ports.connections.revalidate()
    this.ports.connectors.revalidate()
    this.ports.sources.revalidate()
    this.sendContext(record)
    this.sendValues(record)
    if (record.guestId !== undefined) this.surface.visibility(record.guestId, demanded)
  }
  private contextValue(record: GuestRecord): ExtensionContext {
    if (!this.admittedCapabilities(record).includes('context.read'))
      return {
        surface:
          record.view.role === 'updater'
            ? 'updater'
            : (record.context?.value.surface ?? 'viewer'),
        visible: record.visible,
      }
    return boundedExtensionContext(
      record.view.role === 'updater'
        ? {
            surface: 'updater',
            visible: record.visible,
            sessions: boundedExtensionSessions(
              this.ports.updaterSessions(record.activation.installationId),
            ),
          }
        : {
            ...(record.context && this.contexts
              ? this.contexts.admit(record.owner, {
                  surface: record.context.value
                    .surface as ExtensionSurfaceRequest['surface'],
                  ...(record.context.value.workspace
                    ? { workspaceId: record.context.value.workspace.id }
                    : {}),
                  ...(record.context.value.session
                    ? { sessionId: record.context.value.session.id }
                    : {}),
                }).value
              : { surface: 'viewer' as const }),
            visible: record.visible,
            ...(record.initialInput === undefined ? {} : { input: record.initialInput }),
          },
    )
  }
  private sendContext(record: GuestRecord): void {
    if (
      !record.negotiated ||
      record.guestId === undefined ||
      (!record.visible && record.sentContext?.visible === false)
    )
      return
    const context = this.contextValue(record)
    if (JSON.stringify(context) === JSON.stringify(record.sentContext)) return
    record.sentContext = context
    this.surface.send(record.guestId, { kind: 'context', context })
  }

  private admittedCapabilities(record: GuestRecord): string[] {
    const declared = [
      ...record.activation.revision.manifest.requiredCapabilities,
      ...record.activation.revision.manifest.optionalCapabilities,
    ]
    return EXTENSION_CAPABILITIES.filter(
      (capability) =>
        declared.includes(capability) &&
        (record.view.role !== 'updater' ||
          (!capability.startsWith('delivery.') &&
            ![
              'actions.invoke',
              'viewer.open-own',
              'source.select',
              'source.read',
              'source.asset',
              'source.render',
              'source.reveal',
              'terminal.start',
              'connector.connect',
            ].includes(capability))),
    )
  }
  private byGuest(id: number): GuestRecord | undefined {
    return [...this.records.values()].find((record) => record.guestId === id)
  }
  private current(record: GuestRecord): boolean {
    return (
      !this.disposed &&
      record.authority.current() &&
      !record.view.failure &&
      (!record.context || record.context.current()) &&
      this.records.get(record.view.id) === record &&
      this.scopes.isCurrent(record.owner) &&
      this.activations.active.get(record.activation.installationId) === record.activation
    )
  }
  private assertRecord(record: GuestRecord): void {
    if (!this.current(record)) throw new Error('Extension view was revoked')
  }
  private async awaitDisposals(records: Iterable<GuestRecord>): Promise<void> {
    const settled = await Promise.allSettled(
      [...records].map((record) => record.disposal!),
    )
    const failures: unknown[] = []
    for (const result of settled)
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    if (failures.length)
      throw new AggregateError(failures, 'Extension guest cleanup failed')
  }
  private destroySurface(record: GuestRecord): void {
    if (record.disposal) return
    record.disposal = this.surface.destroy(record.view.id)
    this.closing.add(record)
    void record.disposal.then(
      () => this.closing.delete(record),
      () => undefined, // A rejected receipt remains observable by its owner.
    )
  }
  private closeRecord(record: GuestRecord, notify = true): void {
    if (this.records.get(record.view.id) !== record) return
    this.records.delete(record.view.id)
    this.ports.sources.closeView(record.view.id)
    record.authority.dispose()
    this.ports.connections.revalidate()
    this.ports.connectors.revalidate()
    this.ports.sources.revalidate()
    if (record.visible && record.view.role !== 'updater')
      this.ports.visibleContributionsChanged()
    this.ports.actions.revokeView(record.view.id)
    record.contextLease?.release()
    for (const controller of record.requests.values()) controller.abort()
    record.requests.clear()
    if (record.guestId !== undefined)
      this.surface.send(record.guestId, { kind: 'revoked' })
    this.destroySurface(record)
    if (notify) this.publish(record.owner, this.snapshot(record.owner))
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return ownerKey(left) === ownerKey(right)
}
function errorText(reason: unknown): string {
  return (reason instanceof Error ? reason.message : 'Extension request failed').slice(
    0,
    240,
  )
}
