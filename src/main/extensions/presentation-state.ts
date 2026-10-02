import {
  EXTENSION_LIMITS,
  type ExtensionItemValue,
} from '../../shared/extensions/contract'
import { validateExtensionItemValue } from '../../shared/extensions/contributions'
import type { ExtensionActivation } from './activation'

export interface ExtensionPresentationPersistence {
  read(): Promise<unknown>
  save(
    value: Readonly<Record<string, readonly ExtensionItemValue[]>>,
    current: () => void,
    signal: AbortSignal,
  ): Promise<void>
}

/** Presentation only: bounded data, observation freshness, and exact live-session lifetimes. */
export class ExtensionPresentationState {
  private application = new Map<string, readonly ExtensionItemValue[]>()
  private session = new Map<string, readonly ExtensionItemValue[]>()
  private queued = 0
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly persistence: ExtensionPresentationPersistence,
    private readonly changed: () => void,
  ) {}

  async restore(): Promise<void> {
    const value = await this.persistence.read()
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value)) > EXTENSION_LIMITS.presentationTotalBytes
    )
      throw new Error('Invalid saved extension presentation')
    if (Object.keys(value).length > EXTENSION_LIMITS.installations)
      throw new Error('Invalid saved extension presentation')
    for (const [id, values] of Object.entries(value)) {
      if (
        !/^[a-f0-9-]{36}$/u.test(id) ||
        !Array.isArray(values) ||
        values.length > EXTENSION_LIMITS.railItems ||
        Buffer.byteLength(JSON.stringify(values)) > EXTENSION_LIMITS.presentationBytes
      )
        throw new Error('Invalid saved extension presentation')
      const parsed = values.map(validateExtensionItemValue)
      if (
        new Set(parsed.map((entry) => entry.item)).size !== parsed.length ||
        parsed.some((entry) => entry.session)
      )
        throw new Error('Session presentation cannot persist')
      this.application.set(
        id,
        parsed.map((entry) =>
          entry.availability ? { ...entry, availability: 'stale' } : entry,
        ),
      )
    }
  }

  values(activation: ExtensionActivation): readonly ExtensionItemValue[] {
    const items = activation.revision.manifest.railItems ?? []
    return [
      ...(this.application.get(activation.installationId) ?? []),
      ...(this.session.get(activation.installationId) ?? []),
    ].filter((value) => items.some((item) => item.id === value.item))
  }

  publish(
    activation: ExtensionActivation,
    input: unknown,
    sessions: () => readonly string[],
    current: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.queued >= EXTENSION_LIMITS.requests)
      throw new Error('Presentation work capacity is full')
    this.queued++
    const task = this.pending.then(async () => {
      signal.throwIfAborted()
      current()
      const value = validateExtensionItemValue(input)
      const item = activation.revision.manifest.railItems?.find(
        (item) => item.id === value.item,
      )
      if (
        !item ||
        (value.session &&
          (item.placement !== 'session' || !sessions().includes(value.session)))
      )
        throw new Error('Presentation target is undeclared or stale')
      if (
        item.kind === 'control' &&
        (value.availability || value.observedAt !== undefined)
      )
        throw new Error('Control state is not an observation')
      if (item.kind === 'observation' && !value.availability)
        throw new Error('Declare observation availability')
      const map = value.session ? this.session : this.application
      const next = [
        ...(map.get(activation.installationId) ?? []).filter(
          (entry) => entry.item !== value.item || entry.session !== value.session,
        ),
        value,
      ]
      const allSessions = new Map(this.session),
        allApplication = new Map(this.application)
      ;(value.session ? allSessions : allApplication).set(activation.installationId, next)
      if (
        Buffer.byteLength(
          JSON.stringify([
            ...(allSessions.get(activation.installationId) ?? []),
            ...(allApplication.get(activation.installationId) ?? []),
          ]),
        ) > EXTENSION_LIMITS.presentationBytes
      )
        throw new Error('Extension presentation capacity is full')
      if (
        new Set([...allSessions.keys(), ...allApplication.keys()]).size >
          EXTENSION_LIMITS.installations ||
        Buffer.byteLength(JSON.stringify([...allSessions, ...allApplication])) >
          EXTENSION_LIMITS.presentationTotalBytes
      )
        throw new Error('Application presentation capacity is full')
      if (!value.session) {
        const saved = Object.fromEntries(this.application)
        saved[activation.installationId] = next
        if (
          Buffer.byteLength(JSON.stringify(saved)) >
          EXTENSION_LIMITS.presentationTotalBytes
        )
          throw new Error('Application presentation capacity is full')
        await this.persistence.save(saved, current, signal)
        signal.throwIfAborted()
        current()
      }
      map.set(activation.installationId, next)
      this.changed()
    })
    void task
      .finally(() => {
        this.queued--
      })
      .catch(() => undefined)
    this.pending = task.catch(() => undefined)
    return task
  }

  pruneSessions(ids: readonly string[]): void {
    for (const [id, values] of this.session)
      this.session.set(
        id,
        values.filter((value) => ids.includes(value.session!)),
      )
    this.changed()
  }
  stale(id: string): void {
    for (const map of [this.application, this.session])
      map.set(
        id,
        (map.get(id) ?? []).map((value) =>
          value.availability === 'current' ? { ...value, availability: 'stale' } : value,
        ),
      )
    this.changed()
  }
  failed(id: string): void {
    for (const map of [this.application, this.session])
      map.set(
        id,
        (map.get(id) ?? []).map((value) =>
          value.availability ? { ...value, availability: 'failed' } : value,
        ),
      )
    this.changed()
  }
  forget(id: string): void {
    this.application.delete(id)
    this.session.delete(id)
    this.changed()
  }
  revoke(id: string): void {
    this.session.delete(id)
    this.stale(id)
  }
}
