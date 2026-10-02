import { MAX_INTERFACE_FONT_STACK_LENGTH } from '../../shared/interface-typography'
import { randomUUID } from 'node:crypto'
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CONTRACT,
  EXTENSION_LIMITS,
  type ExtensionPresentation,
  type ExtensionReply,
} from '../../shared/extensions/contract'
import {
  extensionId,
  extensionObject,
  extensionText,
  unknownExtensionFields,
} from '../../shared/extensions/manifest'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type { ExtensionActivationOwner, ExtensionActivation } from './activation'
import type { ExtensionRevision } from './package-store'

export interface ExtensionGuestSurfacePort {
  prepare(view: ExtensionView, revision: ExtensionRevision): Promise<void>
  destroy(viewId: string): void
  send(guestId: number, reply: ExtensionReply): void
  visibility(guestId: number, visible: boolean): void
}

interface GuestRecord {
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
  rateStart: number
  messages: number
}

export const DEFAULT_EXTENSION_PRESENTATION: ExtensionPresentation = {
  appearance: 'dark',
  colors: {
    background: '#0f1115',
    surface: '#191c23',
    text: '#e5e7eb',
    muted: '#a3a8b8',
    accent: '#7aa2f7',
  },
  fontFamily: 'system-ui',
  fontSize: 13,
  width: 0,
  height: 0,
}

/** Admission, caller provenance, capability and revocation policy, independent of Electron. */
export class ExtensionGuestOwner {
  private readonly records = new Map<string, GuestRecord>()
  private readonly rendererLeases = new Map<string, RendererResourceLease>()
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
    ) => void,
  ) {}

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
  ): Promise<ExtensionView> {
    this.scopes.assertCurrent(owner)
    await this.activations.assertWritable()
    admit()
    const activation = this.activations.active.get(installationId)
    const contribution = activation?.revision.manifest.views.find(
      (entry) => entry.id === contributionId,
    )
    if (!activation || !contribution || this.disposed)
      throw new Error('Enable this extension before opening its declared view')
    const existing = [...this.records.values()].find(
      (entry) =>
        sameOwner(entry.owner, owner) &&
        entry.activation === activation &&
        entry.view.contributionId === contributionId,
    )
    if (existing) {
      if (!existing.ready || existing.view.failure)
        throw new Error(
          'This view is opening or stopped; close it before opening it again',
        )
      this.publish(owner, this.snapshot(owner), existing.view.id)
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
    }
    const record: GuestRecord = {
      view,
      owner,
      activation,
      requests: new Map(),
      presentation: DEFAULT_EXTENSION_PRESENTATION,
      ready: false,
      claimed: false,
      negotiated: false,
      visible: false,
      rateStart: performance.now(),
      messages: 0,
    }
    this.records.set(id, record)
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
      this.publish(owner, this.snapshot(owner), view.id)
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
    return record.view
  }

  close(owner: RendererOwner, viewId: string): void {
    const record = this.records.get(viewId)
    if (!record || !sameOwner(record.owner, owner)) return
    this.closeRecord(record)
  }

  revokeInstallation(installationId: string): void {
    for (const record of [...this.records.values()])
      if (record.activation.installationId === installationId) this.closeRecord(record)
  }

  closeOwner(owner: RendererOwner): void {
    for (const record of [...this.records.values()])
      if (sameOwner(record.owner, owner)) this.closeRecord(record)
    this.rendererLeases.get(ownerKey(owner))?.release()
    this.rendererLeases.delete(ownerKey(owner))
  }

  failed(guestId: number, explanation?: string): void {
    const record = this.byGuest(guestId)
    if (!record) return
    record.view = {
      ...record.view,
      failure:
        explanation ??
        'This extension view stopped. Close it and open it again from Settings.',
    }
    for (const controller of record.requests.values()) controller.abort()
    record.requests.clear()
    record.guestId = undefined
    this.surface.destroy(record.view.id)
    this.publish(record.owner, this.snapshot(record.owner))
  }

  presentation(
    owner: RendererOwner,
    viewId: string,
    value: ExtensionPresentation,
    visible: boolean,
  ): void {
    const record = this.records.get(viewId)
    if (!record || !sameOwner(record.owner, owner) || !this.current(record)) return
    // Visibility authority is independent of parsing the latest appearance snapshot.
    record.visible = visible === true
    if (record.guestId !== undefined)
      this.surface.visibility(record.guestId, record.visible)
    const colors = extensionObject(value.colors)
    const color = (key: keyof ExtensionPresentation['colors']): string => {
      const text = extensionText(colors[key], 'presentation color', 80)
      if (!/^(#[a-f0-9]{3,8}|rgba?\([\d\s.,%]+\))$/iu.test(text))
        throw new Error('Invalid presentation color')
      return text
    }
    if (value.appearance !== 'light' && value.appearance !== 'dark')
      throw new Error('Invalid appearance')
    if (
      ![value.width, value.height, value.fontSize].every(
        (number) => Number.isFinite(number) && number >= 0 && number <= 16_384,
      ) ||
      value.fontSize < 8 ||
      value.fontSize > 48
    )
      throw new Error('Invalid view presentation size')
    record.presentation = {
      appearance: value.appearance,
      colors: {
        background: color('background'),
        surface: color('surface'),
        text: color('text'),
        muted: color('muted'),
        accent: color('accent'),
      },
      fontFamily: extensionText(
        value.fontFamily,
        'interface font',
        MAX_INTERFACE_FONT_STACK_LENGTH,
      ),
      fontSize: value.fontSize,
      width: value.width,
      height: value.height,
    }
    if (record.guestId !== undefined) {
      if (record.negotiated && record.visible)
        this.surface.send(record.guestId, {
          kind: 'presentation',
          presentation: record.presentation,
        })
    }
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
        return
      }
      id = extensionText(message['id'], 'request identity', 80)
      if (!/^[a-zA-Z0-9-]+$/u.test(id)) throw new Error('Invalid request identity')
      if (message['kind'] === 'cancel') {
        record.requests.get(id)?.abort()
        return
      }
      warnings = unknownExtensionFields(message, ['kind', 'id', 'capability', 'input'])
      if (message['kind'] !== 'request' || !record.negotiated)
        throw new Error('Negotiate before requesting a capability')
      const capability = extensionText(message['capability'], 'capability', 80)
      if (!this.admittedCapabilities(record).includes(capability))
        throw new Error(
          `Extension contract ${record.activation.revision.manifest.contract}: capability ${capability} is unavailable or undeclared`,
        )
      if (!record.visible)
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
          ]),
        ].slice(0, EXTENSION_LIMITS.warnings)
      const controller = new AbortController()
      record.requests.set(id, controller)
      const timer = setTimeout(
        () => controller.abort(),
        EXTENSION_LIMITS.requestTimeoutMs,
      )
      void this.request(record, capability, message['input'], controller.signal)
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
    return Promise.resolve()
  }

  private async request(
    record: GuestRecord,
    capability: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.activations.assertWritable()
    this.assertRecord(record)
    signal.throwIfAborted()
    if (capability === 'presentation.read') return record.presentation
    if (capability === 'viewer.open-own') {
      const target = extensionObject(input)
      const contributionId = extensionId(target['contributionId'])
      // Unknown approval/target fields confer nothing; only this activation's declarations are consulted.
      const opened = await this.open(
        record.owner,
        record.activation.installationId,
        contributionId,
        () => {
          signal.throwIfAborted()
          this.assertRecord(record)
        },
      )
      return { viewId: opened.id }
    }
    throw new Error('Unknown extension capability')
  }

  private admittedCapabilities(record: GuestRecord): string[] {
    const declared = [
      ...record.activation.revision.manifest.requiredCapabilities,
      ...record.activation.revision.manifest.optionalCapabilities,
    ]
    return EXTENSION_CAPABILITIES.filter((capability) => declared.includes(capability))
  }
  private byGuest(id: number): GuestRecord | undefined {
    return [...this.records.values()].find((record) => record.guestId === id)
  }
  private current(record: GuestRecord): boolean {
    return (
      !this.disposed &&
      !record.view.failure &&
      this.records.get(record.view.id) === record &&
      this.scopes.isCurrent(record.owner) &&
      this.activations.active.get(record.activation.installationId) === record.activation
    )
  }
  private assertRecord(record: GuestRecord): void {
    if (!this.current(record)) throw new Error('Extension view was revoked')
  }
  private closeRecord(record: GuestRecord, notify = true): void {
    if (this.records.get(record.view.id) !== record) return
    this.records.delete(record.view.id)
    for (const controller of record.requests.values()) controller.abort()
    record.requests.clear()
    if (record.guestId !== undefined)
      this.surface.send(record.guestId, { kind: 'revoked' })
    this.surface.destroy(record.view.id)
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
