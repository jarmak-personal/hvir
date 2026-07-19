import { hostPathEquals, type HostPath } from '../shared'

export interface RendererOwner {
  readonly id: number
  readonly generation: number
}

export type RendererResourceQualifier =
  | {
      readonly lifetime: 'renderer'
      readonly type: 'attention' | 'ssh-prompt-presentation'
    }
  | {
      readonly lifetime: 'workspace'
      readonly type: 'pty-session' | 'web-pane' | 'html-preview'
      readonly root: HostPath
      readonly id: string
    }

export interface RendererResourceLease {
  /** Unregister after the resource ended itself, without invoking its disposer. */
  readonly release: () => void
  /** Revoke and dispose the resource now. Safe to repeat. */
  readonly dispose: () => Promise<void>
}

export interface RendererResourceRegistrationOptions {
  /** Reuse an equivalent existing registration for an intentionally idempotent resource. */
  readonly duplicate?: 'reuse'
}

export interface RendererOwnerTransition {
  readonly owner: RendererOwner
  readonly cleanup: Promise<void>
}

interface ResourceRecord {
  readonly key: string
  readonly owner: RendererOwner
  readonly qualifier: RendererResourceQualifier
  readonly dispose: () => void | Promise<void>
  active: boolean
}

/**
 * Central lifetime registry for main-owned resources presented to a renderer.
 * Revocation removes authority synchronously, then tears resources down in LIFO order.
 */
export class RendererResourceScopes {
  private readonly generations = new Map<number, number>()
  private readonly activeOwners = new Map<number, RendererOwner>()
  private readonly resources = new Map<string, ResourceRecord>()
  private readonly cleanups = new Set<Promise<void>>()

  activateOwner(id: number): RendererOwner {
    const active = this.activeOwners.get(id)
    if (active) return active
    const owner = { id, generation: (this.generations.get(id) ?? 0) + 1 }
    this.generations.set(id, owner.generation)
    this.activeOwners.set(id, owner)
    return owner
  }

  currentOwner(id: number): RendererOwner {
    const owner = this.activeOwners.get(id)
    if (!owner) throw new Error(`Renderer owner ${id} is not active`)
    return owner
  }

  isCurrent(owner: RendererOwner): boolean {
    const current = this.activeOwners.get(owner.id)
    return current?.generation === owner.generation
  }

  assertCurrent(owner: RendererOwner): void {
    if (!this.isCurrent(owner)) {
      throw new Error(`Renderer owner ${owner.id}:${owner.generation} has been revoked`)
    }
  }

  rolloverOwner(id: number): RendererOwnerTransition {
    const previous = this.activeOwners.get(id)
    if (previous) this.activeOwners.delete(id)
    const records = previous
      ? this.take((record) => sameOwner(record.owner, previous))
      : []
    const owner = this.activateOwner(id)
    return { owner, cleanup: this.trackCleanup(this.disposeRecords(records)) }
  }

  revokeOwner(id: number): Promise<void> {
    const owner = this.activeOwners.get(id)
    if (!owner) return Promise.resolve()
    this.activeOwners.delete(id)
    return this.trackCleanup(
      this.disposeRecords(this.take((record) => sameOwner(record.owner, owner))),
    )
  }

  register(
    owner: RendererOwner,
    qualifier: RendererResourceQualifier,
    dispose: () => void | Promise<void>,
    options: RendererResourceRegistrationOptions = {},
  ): RendererResourceLease {
    this.assertCurrent(owner)
    const key = resourceKey(owner, qualifier)
    const existing = this.resources.get(key)
    if (existing) {
      if (options.duplicate === 'reuse') return this.lease(existing)
      throw new Error(`Renderer ${qualifier.type} resource is already registered`)
    }
    const record: ResourceRecord = { key, owner, qualifier, dispose, active: true }
    this.resources.set(key, record)
    return this.lease(record)
  }

  private lease(record: ResourceRecord): RendererResourceLease {
    return {
      release: () => this.release(record),
      dispose: () => this.disposeRecord(record),
    }
  }

  async disposeResource(
    owner: RendererOwner,
    type: RendererResourceQualifier['type'],
    id?: string,
  ): Promise<boolean> {
    const records = this.take(
      (record) =>
        sameOwner(record.owner, owner) &&
        record.qualifier.type === type &&
        (id === undefined ||
          (record.qualifier.lifetime === 'workspace' && record.qualifier.id === id)),
    )
    await this.disposeRecords(records)
    return records.length > 0
  }

  revokeWorkspace(root: HostPath): Promise<void> {
    return this.trackCleanup(
      this.disposeRecords(
        this.take(
          (record) =>
            record.qualifier.lifetime === 'workspace' &&
            hostPathEquals(record.qualifier.root, root),
        ),
      ),
    )
  }

  async dispose(): Promise<void> {
    this.activeOwners.clear()
    await this.trackCleanup(this.disposeRecords(this.take(() => true)))
    await Promise.allSettled([...this.cleanups])
  }

  private release(record: ResourceRecord): void {
    if (!record.active) return
    record.active = false
    if (this.resources.get(record.key) === record) this.resources.delete(record.key)
  }

  private disposeRecord(record: ResourceRecord): Promise<void> {
    if (!record.active) return Promise.resolve()
    this.release(record)
    return this.trackCleanup(Promise.resolve().then(record.dispose))
  }

  private take(predicate: (record: ResourceRecord) => boolean): ResourceRecord[] {
    const records = [...this.resources.values()].filter(predicate).reverse()
    for (const record of records) this.release(record)
    return records
  }

  private async disposeRecords(records: readonly ResourceRecord[]): Promise<void> {
    const failures: unknown[] = []
    for (const record of records) {
      try {
        await record.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Renderer resource cleanup failed')
    }
  }

  private trackCleanup(cleanup: Promise<void>): Promise<void> {
    this.cleanups.add(cleanup)
    void cleanup.then(
      () => this.cleanups.delete(cleanup),
      () => this.cleanups.delete(cleanup),
    )
    return cleanup
  }
}

function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}

function resourceKey(owner: RendererOwner, qualifier: RendererResourceQualifier): string {
  return JSON.stringify(
    qualifier.lifetime === 'renderer'
      ? [owner.id, owner.generation, qualifier.type]
      : [
          owner.id,
          owner.generation,
          qualifier.type,
          qualifier.root.hostId,
          qualifier.root.path,
          qualifier.id,
        ],
  )
}
