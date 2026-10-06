import { DELIVERY_LIMITS } from '../../shared/extensions/managed-delivery'
import type { ExtensionConnectorApproval } from '../../shared/extensions/connectors'
import { CONNECTOR_LIMITS } from '../../shared/extensions/connectors'
import {
  SOURCE_LIMITS,
  type ExtensionSourceGrant,
} from '../../shared/extensions/source-access'
import { randomUUID } from 'node:crypto'
import {
  EXTENSION_LIMITS,
  type ExtensionItemValue,
} from '../../shared/extensions/contract'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
} from '../../shared/extensions/workbench'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { ExtensionPackageStore, type ExtensionRevision } from './package-store'
import {
  readInstallationState,
  type AcceptedInstallation,
  type PackageRemoval,
} from './installation-state'
import { finishPackageRemoval } from './package-removal'
import { importExtensionPackage } from './package-import'
import { selectExtensionPackage } from './package-selection'
import { collectExtensionPackages } from './package-retention'
import type { ExtensionWriterLease } from '../project-host/extension-storage-port'

export interface ExtensionActivation {
  readonly installationId: string
  readonly generation: string
  readonly revision: ExtensionRevision
}

/** Authority-bearing package state. Discovery executes nothing and never changes an activation. */
export class ExtensionActivationOwner {
  readonly active = new Map<string, ExtensionActivation>()
  private accepted: AcceptedInstallation[] = []
  private removals: PackageRemoval[] = []
  private discovered = new Map<string, ExtensionRevision>()
  private sourceIdentities = new Map<string, string>()
  private installations: ExtensionInstallation[] = []
  private writer?: ExtensionWriterLease
  private explanation?: string
  private importCapacity = false
  private restoring = true
  private disposed = false
  private pending: Promise<unknown> = Promise.resolve()
  private releaseTask: Promise<void> = Promise.resolve()
  private stopping?: Promise<void>
  private readonly authority = new AbortController()
  private readonly agentLifetimes = new Map<string, AbortController>()
  private readonly agentRevoked = new Set<string>()
  private readonly agentIntents = new Map<string, object>()

  constructor(
    private readonly host: ProjectHost,
    readonly directory: HostPath,
    private readonly stateFile: HostPath,
    readonly packages: ExtensionPackageStore,
    private readonly revoke: (installationId: string) => void,
    private readonly changed: (state: ExtensionPlatformState) => void,
    private readonly forgotten: (
      installationId: string,
    ) => readonly ExtensionConnectorApproval[] | void = () => undefined,
    private readonly sourceForgotten: (
      installationId: string,
    ) => readonly ExtensionSourceGrant[] | void = () => undefined,
    private readonly deliveryForgotten: (
      installationId: string,
      persisted: unknown,
    ) => {
      readonly journal: unknown
      commitJournal(): void
      commitDomain(): void
    } | void = () => undefined,
  ) {}

  start(lock: HostPath): Promise<void> {
    return this.serialize(() => this.initialize(lock))
  }

  private async initialize(lock: HostPath): Promise<void> {
    if (!this.host.extensionStorage) {
      this.explanation = 'Extension storage is unavailable in this installation'
      return
    }
    this.writer = await this.host.extensionStorage.acquireWriter(lock, () =>
      this.loseOwnership(),
    )
    if (this.disposed) {
      await this.writer?.release()
      this.writer = undefined
      return
    }
    if (!this.writer) {
      this.explanation =
        'Another hvir instance uses extensions in this data directory. Close it or start hvir with a separate user-data directory.'
      return
    }
    try {
      const workload = await this.host.readTextFilePrefix(this.stateFile, 64 * 1024)
      if (!workload.complete || workload.validUtf8 === false)
        throw new Error('Extension state exceeds its size limit')
      const state = readInstallationState(JSON.parse(workload.content))
      this.accepted = state.installations
      this.removals = state.removals
    } catch (reason) {
      if ((reason as { code?: unknown }).code !== 'ENOENT') {
        this.explanation =
          'Extension state cannot be read safely. Ordinary workbench features remain available; repair the extension state file before enabling packages.'
        await this.writer.release()
        this.writer = undefined
        return
      }
    }
    await this.scan()
    for (const saved of this.accepted.filter((entry) => entry.enabled)) {
      const source = this.discovered.get(saved.source)
      if (
        !source ||
        source.sourceIdentity !== saved.sourceIdentity ||
        source.hash !== saved.revision ||
        this.removals.some((entry) => entry.source === saved.source)
      )
        continue
      try {
        const revision = await this.packages.load(saved.revision)
        await this.assertWritable()
        this.active.set(saved.installationId, {
          installationId: saved.installationId,
          generation: randomUUID(),
          revision,
        })
      } catch {
        this.installations = this.installations.map((entry) =>
          entry.source === saved.source
            ? {
                ...entry,
                error:
                  'The accepted package revision could not be restored safely. Repair its stored revision before enabling it.',
              }
            : entry,
        )
      }
    }
    this.restoring = false
    const restored = this.accepted.map((entry) =>
      entry.enabled && !this.active.has(entry.installationId)
        ? { ...entry, enabled: false }
        : entry,
    )
    if (restored.some((entry, index) => entry !== this.accepted[index]))
      await this.save(restored)
    await this.collect().catch((reason: unknown) => {
      this.explanation = `Package cleanup needs attention: ${reason instanceof Error ? reason.message : 'cleanup failed'}`
    })
    this.publish()
  }

  snapshot(): ExtensionPlatformState {
    return {
      writable: !!this.writer && !this.disposed,
      ...(this.explanation ? { explanation: this.explanation } : {}),
      installations: this.installations.map((entry) => {
        const accepted = this.accepted.find(
          (item) => item.source === entry.source || item.packageId === entry.manifest?.id,
        )
        return {
          ...entry,
          ...(accepted && this.active.get(accepted.installationId)
            ? { manifest: this.active.get(accepted.installationId)!.revision.manifest }
            : {}),
          installationId: accepted?.installationId,
          acceptedRevision: accepted?.revision,
          removalPending: this.removals.some((item) => item.source === entry.source),
          retainedIdentity: !!accepted && !accepted.enabled,
          enabled: !!accepted && this.active.has(accepted.installationId),
        }
      }),
    }
  }

  discover(): Promise<ExtensionPlatformState> {
    return this.serialize(() => this.scan())
  }

  async add(
    pick: () => Promise<HostPath | undefined>,
    assertCurrent: () => void,
    signal: AbortSignal,
  ): Promise<ExtensionPlatformState> {
    const lifetime = AbortSignal.any([signal, this.authority.signal])
    const current = async (): Promise<void> => {
      lifetime.throwIfAborted()
      assertCurrent()
      await this.assertWritable()
      lifetime.throwIfAborted()
      assertCurrent()
    }
    await current()
    const source = await selectExtensionPackage(pick, assertCurrent, lifetime)
    await current()
    if (!source) return this.snapshot()
    return this.serialize(async () => {
      await current()
      const imported = await importExtensionPackage(
        this.host,
        this.directory,
        this.packages.root,
        source,
        async (name, id) => {
          if (
            [...this.active.values()].some((entry) => entry.revision.manifest.id === id)
          )
            throw new Error(
              'This extension identity is enabled. Use its existing Reload or Replace control.',
            )
          await current()
          await this.scan(() => {
            lifetime.throwIfAborted()
            assertCurrent()
          })
          if (this.importCapacity)
            throw new Error('Remove an unused package before adding another extension')
          if (
            this.installations.some(
              (entry) => entry.source === name && entry.sourceIdentity,
            )
          )
            throw new Error(
              'A package with this filename already exists. Remove it explicitly or choose a different filename.',
            )
          if (
            this.installations.some(
              (entry) => entry.manifest?.id === id && entry.sourceIdentity,
            ) ||
            this.removals.some(
              (entry) =>
                entry.source === name ||
                this.accepted.some(
                  (saved) => saved.source === entry.source && saved.packageId === id,
                ),
            )
          )
            throw new Error(
              'This extension identity is already present or removal is unfinished. Finish Remove before adding it again.',
            )
        },
        current,
        () => {
          lifetime.throwIfAborted()
          assertCurrent()
        },
        lifetime,
      )
      await current()
      await this.scan(() => {
        lifetime.throwIfAborted()
        assertCurrent()
      })
      if (this.sourceIdentities.get(imported.source) !== imported.sourceIdentity)
        throw new Error('The imported package changed; discover it before enabling it')
      return this.acceptRevision(
        imported.source,
        imported.revision,
        false,
        current,
        lifetime,
      )
    })
  }

  private async scan(
    current: () => void = () => undefined,
  ): Promise<ExtensionPlatformState> {
    if (this.disposed) throw new Error('Extensions have stopped')
    const entries = await this.host.extensionStorage!.installationNames(
      this.directory,
      EXTENSION_LIMITS.installations * 2,
    )
    const staged = new Set(this.removals.map((entry) => entry.staging))
    const ordinary = entries.filter((name) => !name.startsWith('.') && !staged.has(name))
    this.importCapacity = ordinary.length >= EXTENSION_LIMITS.installations
    this.discovered.clear()
    this.sourceIdentities.clear()
    this.installations = []
    if (ordinary.length > EXTENSION_LIMITS.installations) {
      this.installations = [
        {
          source: 'extensions',
          warnings: [],
          enabled: false,
          error: `Keep at most ${EXTENSION_LIMITS.installations} packages in the extensions folder`,
        },
      ]
      current()
      this.publish()
      return this.snapshot()
    }
    for (const name of [...ordinary].sort()) {
      try {
        const path = joinHostPath(this.directory, name)
        const entryIdentity = await this.host.extensionStorage!.entryIdentity(path)
        this.sourceIdentities.set(name, entryIdentity)
        const revision = await this.packages.captureSource(path, this.authority.signal)
        this.discovered.set(name, revision)
        this.installations.push({
          source: name,
          sourceIdentity: entryIdentity,
          kind: revision.kind,
          manifest: revision.manifest,
          revision: revision.hash,
          warnings: revision.warnings,
          enabled: false,
        })
      } catch (reason) {
        this.installations.push({
          source: name,
          warnings: [],
          ...(this.sourceIdentities.get(name)
            ? { sourceIdentity: this.sourceIdentities.get(name) }
            : {}),
          kind:
            (
              await this.host
                .stat(joinHostPath(this.directory, name))
                .catch(() => undefined)
            )?.type === 'symlink'
              ? 'development'
              : undefined,
          enabled: false,
          error: reason instanceof Error ? reason.message : 'Package cannot be read',
        })
      }
    }
    const counts = new Map<string, number>()
    for (const revision of this.discovered.values())
      counts.set(revision.manifest.id, (counts.get(revision.manifest.id) ?? 0) + 1)
    this.installations = this.installations.map((entry) => {
      if (!entry.manifest || counts.get(entry.manifest.id) === 1) return entry
      this.discovered.delete(entry.source)
      return { ...entry, error: `Duplicate extension identity: ${entry.manifest.id}` }
    })
    for (const [id] of this.active) {
      const accepted = this.accepted.find((entry) => entry.installationId === id)
      const source = accepted && this.discovered.get(accepted.source)
      if (
        !accepted ||
        !source ||
        source.sourceIdentity !== accepted.sourceIdentity ||
        source.hash !== accepted.revision
      )
        this.revokeActivation(id)
    }
    for (const saved of this.accepted) {
      if (
        this.installations.some(
          (entry) =>
            entry.source === saved.source || entry.manifest?.id === saved.packageId,
        )
      )
        continue
      this.installations.push({
        source: saved.source,
        manifest: undefined,
        warnings: [],
        enabled: false,
        kind: saved.kind,
        error: this.removals.some((entry) => entry.source === saved.source)
          ? 'Package removal is unfinished. Retry Remove to finish cleanup.'
          : 'Package is missing. Use Add extension to reinstall it.',
      })
    }
    for (const removal of this.removals) {
      if (!this.installations.some((entry) => entry.source === removal.source))
        this.installations.push({
          source: removal.source,
          kind: removal.kind,
          warnings: [],
          enabled: false,
          error: 'Package removal is unfinished. Retry Remove to finish cleanup.',
        })
    }
    const next = this.accepted.map((entry) =>
      entry.enabled && !this.active.has(entry.installationId)
        ? { ...entry, enabled: false }
        : entry,
    )
    if (
      this.writer &&
      !this.restoring &&
      next.some((entry, index) => entry !== this.accepted[index])
    )
      await this.save(next)
    current()
    this.publish()
    return this.snapshot()
  }

  enable(source: string, expectedRevision: string): Promise<ExtensionPlatformState> {
    return this.serialize(() => this.acceptRevision(source, expectedRevision, false))
  }

  reload(source: string, expectedRevision: string): Promise<ExtensionPlatformState> {
    return this.serialize(() => this.acceptRevision(source, expectedRevision, true))
  }

  private async acceptRevision(
    source: string,
    expectedRevision: string,
    replacing: boolean,
    currentIntent: () => Promise<void> = () => this.assertWritable(),
    signal: AbortSignal = this.authority.signal,
  ): Promise<ExtensionPlatformState> {
    await currentIntent()
    const discovered = this.discovered.get(source)
    if (!discovered || (!replacing && discovered.hash !== expectedRevision))
      throw new Error('Discover this package again before accepting it')
    const current = await this.packages.captureSource(
      joinHostPath(this.directory, source),
      signal,
    )
    if (
      !replacing &&
      (current.hash !== discovered.hash ||
        current.sourceIdentity !== discovered.sourceIdentity)
    )
      throw new Error('The package changed; discover it and inspect its access again')
    const prior = this.accepted.find((entry) => entry.packageId === current.manifest.id)
    if (
      replacing &&
      expectedRevision !== discovered.hash &&
      expectedRevision !== prior?.revision
    )
      throw new Error('Discover this package again before accepting its revision')
    const occupied = this.accepted.find(
      (entry) => entry.source === source && entry.packageId !== current.manifest.id,
    )
    if (occupied || this.removals.some((entry) => entry.source === source))
      throw new Error(
        'Remove the earlier installation state before accepting this package identity',
      )
    if (prior && this.active.has(prior.installationId) && !replacing)
      throw new Error('Use Reload or Replace to accept the new revision')
    if (!prior && this.accepted.length >= EXTENSION_LIMITS.installations)
      throw new Error('Remove unused installation state before accepting another package')
    await currentIntent()
    await this.collect(current)
    await currentIntent()
    await this.packages.retain(current, signal)
    await currentIntent()
    const record: AcceptedInstallation = {
      installationId: prior?.installationId ?? randomUUID(),
      packageId: current.manifest.id,
      source,
      sourceIdentity: current.sourceIdentity,
      kind: current.kind,
      revision: current.hash,
      enabled: true,
      agentAccess: prior?.agentAccess ?? false,
    }
    if (prior) this.revokeActivation(prior.installationId)
    await this.save(
      [...this.accepted.filter((entry) => entry !== prior), record],
      this.removals,
      currentIntent,
      signal,
    )
    await currentIntent()
    this.discovered.set(source, current)
    this.installations = this.installations.map((entry) =>
      entry.source === source
        ? {
            ...entry,
            revision: current.hash,
            manifest: current.manifest,
            warnings: current.warnings,
            kind: current.kind,
            sourceIdentity: current.sourceIdentity.split(':').slice(0, 2).join(':'),
          }
        : entry,
    )
    this.active.set(record.installationId, {
      installationId: record.installationId,
      generation: randomUUID(),
      revision: current,
    })
    this.publish()
    return this.snapshot()
  }

  remove(
    source: string,
    expectedIdentity: string | undefined,
    forget: boolean,
  ): Promise<ExtensionPlatformState> {
    return this.serialize(async () => {
      if (typeof forget !== 'boolean')
        throw new Error('Choose whether to keep or forget the saved extension setup')
      await this.assertWritable()
      const selected = this.installations.find((entry) => entry.source === source)
      const prior = this.accepted.find(
        (entry) =>
          entry.installationId === selected?.installationId ||
          entry.source === source ||
          entry.packageId === selected?.manifest?.id,
      )
      if (prior) {
        this.revokeActivation(prior.installationId)
        await this.save(
          this.accepted.map((entry) =>
            entry === prior ? { ...entry, enabled: false } : entry,
          ),
        )
      }
      if (!selected)
        throw new Error('Discover the selected package again before removing it')
      const storage = this.host.extensionStorage!
      const path = joinHostPath(this.directory, source)
      const absentIdentity = async (path: HostPath): Promise<string | undefined> =>
        storage.entryIdentity(path).catch((reason: unknown) => {
          if ((reason as { code?: unknown }).code === 'ENOENT') return undefined
          throw reason
        })
      const pendingRemoval = this.removals.find((entry) => entry.source === source)
      let removal = pendingRemoval ? { ...pendingRemoval, forget } : undefined
      const identity = await absentIdentity(path)
      if (!removal && identity) {
        if (this.removals.length >= EXTENSION_LIMITS.installations)
          throw new Error('Finish pending package removals before starting another')
        if (!expectedIdentity || identity !== expectedIdentity)
          throw new Error(
            'The selected package entry changed; discover it again before removing it',
          )
        const type = (await this.host.stat(path)).type
        if (!['dir', 'file', 'symlink'].includes(type))
          throw new Error(
            'Package removal supports only a directory, ZIP, or development link',
          )
        removal = {
          source,
          staging: `remove-${randomUUID()}${type === 'file' ? '.zip' : ''}`,
          identity,
          forget,
          kind: type === 'symlink' ? 'development' : type === 'dir' ? 'directory' : 'zip',
        }
      }
      await this.save(
        this.accepted.map((entry) =>
          entry === prior ? { ...entry, enabled: false } : entry,
        ),
        removal
          ? [...this.removals.filter((entry) => entry.source !== source), removal]
          : this.removals,
      )
      if (removal) {
        await finishPackageRemoval(
          this.host,
          this.directory,
          removal,
          this.authority.signal,
          () => this.assertWritable(),
          () =>
            this.save(
              this.accepted,
              this.removals.filter((entry) => entry.source !== source),
            ),
        )
        forget = removal.forget
      }
      if (forget && prior) {
        const saved = await this.readPresentationFile()
        const next = { ...saved } as Record<string, unknown>
        delete next[prior.installationId]
        await this.assertWritable()
        await this.host.writeFile(this.presentationFile(), JSON.stringify(next), {
          signal: this.authority.signal,
        })
        await this.assertWritable()
        const approvals = this.forgotten(prior.installationId)
        if (approvals !== undefined)
          await this.writeConnectorApprovals(approvals, () => undefined)
        const sourceGrants = this.sourceForgotten(prior.installationId)
        if (sourceGrants !== undefined)
          await this.writeSourceGrants(sourceGrants, () => undefined)
      }
      if (forget && prior) {
        const delivery = this.deliveryForgotten(
          prior.installationId,
          await this.readDeliveryFile('deliveries.json', DELIVERY_LIMITS.stateBytes, {
            records: [],
            operations: [],
          }),
        )
        if (delivery !== undefined) {
          await this.writeDeliveryFile(
            'deliveries.json',
            delivery.journal,
            DELIVERY_LIMITS.stateBytes,
            () => undefined,
          )
          delivery.commitJournal()
        }
        const domain = (await this.readDeliveryFile(
          'delivery-domain.json',
          DELIVERY_LIMITS.domainTotalBytes,
          {},
        )) as Record<string, unknown>
        delete domain[prior.installationId]
        await this.writeDeliveryFile(
          'delivery-domain.json',
          domain,
          DELIVERY_LIMITS.domainTotalBytes,
          () => undefined,
        )
        delivery?.commitDomain()
      }
      await this.save(
        forget
          ? this.accepted.filter(
              (entry) =>
                entry !== prior && entry.installationId !== prior?.installationId,
            )
          : this.accepted,
        this.removals.filter((entry) => entry.source !== source),
      )
      await this.collect()
      return this.scan()
    }).catch((reason: unknown) => {
      this.publish()
      throw reason
    })
  }

  private async save(
    next: AcceptedInstallation[],
    removals = this.removals,
    current: () => Promise<void> = () => this.assertWritable(),
    signal: AbortSignal = this.authority.signal,
  ): Promise<void> {
    await current()
    await this.host.writeFile(
      this.stateFile,
      JSON.stringify({ installations: next, removals }),
      {
        signal,
      },
    )
    await current()
    this.accepted = next
    this.removals = removals
    const retained = new Set(next.map((entry) => entry.installationId))
    for (const id of this.agentRevoked)
      if (!retained.has(id)) this.agentRevoked.delete(id)
    for (const id of this.agentIntents.keys())
      if (!retained.has(id)) this.agentIntents.delete(id)
  }

  private collect(candidate?: ExtensionRevision): Promise<void> {
    const pins = new Set(this.accepted.map((entry) => entry.revision))
    for (const activation of this.active.values()) pins.add(activation.revision.hash)
    if (candidate) pins.add(candidate.hash)
    return collectExtensionPackages(
      this.host,
      this.packages,
      pins,
      () => this.assertWritable(),
      candidate,
      this.authority.signal,
    )
  }

  disable(installationId: string): Promise<ExtensionPlatformState> {
    return this.serialize(async () => {
      await this.assertWritable()
      this.revokeActivation(installationId)
      const next = this.accepted.map((entry) =>
        entry.installationId === installationId ? { ...entry, enabled: false } : entry,
      )
      await this.save(next)
      this.publish()
      return this.snapshot()
    })
  }

  agentAccess(): readonly string[] {
    if (!this.writer || this.disposed) return []
    return this.accepted
      .filter(
        (entry) => entry.agentAccess && !this.agentRevoked.has(entry.installationId),
      )
      .map((entry) => entry.installationId)
  }

  agentSignal(installationId: string): AbortSignal {
    if (!this.agentAccess().includes(installationId))
      throw new Error('Agent access for this extension is off')
    let lifetime = this.agentLifetimes.get(installationId)
    if (!lifetime) {
      lifetime = new AbortController()
      this.agentLifetimes.set(installationId, lifetime)
    }
    return AbortSignal.any([this.authority.signal, lifetime.signal])
  }

  configureAgentAccess(installationId: string, enabled: boolean): Promise<void> {
    if (typeof installationId !== 'string' || typeof enabled !== 'boolean')
      return Promise.reject(new Error('Invalid extension agent access'))
    if (this.disposed || !this.writer) return this.assertWritable()
    if (!this.accepted.some((entry) => entry.installationId === installationId))
      return Promise.reject(new Error('Extension installation is unavailable'))
    const intent = {}
    this.agentIntents.set(installationId, intent)
    // Stricter trusted intent revokes actions before queued persistence can run.
    if (!enabled) {
      this.agentRevoked.add(installationId)
      this.agentLifetimes.get(installationId)?.abort()
      this.agentLifetimes.delete(installationId)
      this.publish()
    }
    return this.serialize(async () => {
      await this.assertWritable()
      if (!this.accepted.some((entry) => entry.installationId === installationId))
        throw new Error('Extension installation is unavailable')
      await this.save(
        this.accepted.map((entry) =>
          entry.installationId === installationId
            ? { ...entry, agentAccess: enabled }
            : entry,
        ),
      )
      if (enabled && this.agentIntents.get(installationId) === intent)
        this.agentRevoked.delete(installationId)
      this.publish()
    })
  }

  async assertWritable(): Promise<void> {
    if (this.disposed || !this.writer)
      throw new Error(
        this.explanation ?? 'Extension state write ownership is unavailable',
      )
    try {
      await this.writer.assertCurrent()
    } catch (reason) {
      throw new Error('Extension state write ownership was revoked', { cause: reason })
    }
    if (this.disposed || !this.writer)
      throw new Error('Extension state write ownership was revoked')
  }

  readConnectorApprovals(): Promise<unknown> {
    return this.serialize(async () => {
      await this.assertWritable()
      try {
        const data = await this.host.readTextFilePrefix(
          joinHostPath(this.stateFile, '..', 'connectors.json'),
          CONNECTOR_LIMITS.stateBytes,
        )
        await this.assertWritable()
        if (!data.complete || data.validUtf8 === false)
          throw new Error('Connector approval state exceeds its bound')
        return JSON.parse(data.content) as unknown
      } catch (reason) {
        await this.assertWritable()
        if ((reason as { code?: unknown }).code === 'ENOENT') return []
        throw new Error('Connector approval state cannot be read safely', {
          cause: reason,
        })
      }
    })
  }

  saveConnectorApprovals(value: unknown, current: () => void): Promise<void> {
    return this.serialize(() => this.writeConnectorApprovals(value, current))
  }

  private async writeConnectorApprovals(
    value: unknown,
    current: () => void,
  ): Promise<void> {
    await this.assertWritable()
    current()
    const content = JSON.stringify(value)
    if (Buffer.byteLength(content) > CONNECTOR_LIMITS.stateBytes)
      throw new Error('Connector approval state exceeds its bound')
    await this.host.writeFile(
      joinHostPath(this.stateFile, '..', 'connectors.json'),
      content,
      { signal: this.authority.signal },
    )
    await this.assertWritable()
    current()
  }

  readSourceGrants(): Promise<unknown> {
    return this.serialize(async () => {
      await this.assertWritable()
      try {
        const data = await this.host.readTextFilePrefix(
          joinHostPath(this.stateFile, '..', 'sources.json'),
          SOURCE_LIMITS.stateBytes,
        )
        await this.assertWritable()
        if (!data.complete || data.validUtf8 === false)
          throw new Error('Source grant state exceeds its bound')
        return JSON.parse(data.content) as unknown
      } catch (reason) {
        await this.assertWritable()
        if ((reason as { code?: unknown }).code === 'ENOENT') return []
        throw new Error('Source grants cannot be read safely', { cause: reason })
      }
    })
  }
  saveSourceGrants(value: unknown, current: () => void): Promise<void> {
    return this.serialize(() => this.writeSourceGrants(value, current))
  }
  private async writeSourceGrants(value: unknown, current: () => void): Promise<void> {
    await this.assertWritable()
    current()
    const content = JSON.stringify(value)
    if (Buffer.byteLength(content) > SOURCE_LIMITS.stateBytes)
      throw new Error('Source grant state exceeds its bound')
    await this.host.writeFile(
      joinHostPath(this.stateFile, '..', 'sources.json'),
      content,
      { signal: this.authority.signal },
    )
    await this.assertWritable()
    current()
  }

  hasInstallationIdentity(id: string): boolean {
    return this.accepted.some((entry) => entry.installationId === id)
  }
  readManagedDeliveries(): Promise<unknown> {
    return this.serialize(() =>
      this.readDeliveryFile('deliveries.json', DELIVERY_LIMITS.stateBytes, {
        records: [],
        operations: [],
      }),
    )
  }
  saveManagedDeliveries(value: unknown, current: () => void): Promise<void> {
    return this.serialize(() =>
      this.writeDeliveryFile(
        'deliveries.json',
        value,
        DELIVERY_LIMITS.stateBytes,
        current,
      ),
    )
  }
  readDeliveryDomain(): Promise<unknown> {
    return this.serialize(() =>
      this.readDeliveryFile('delivery-domain.json', DELIVERY_LIMITS.domainTotalBytes, {}),
    )
  }
  saveDeliveryDomain(value: unknown, current: () => void): Promise<void> {
    return this.serialize(() =>
      this.writeDeliveryFile(
        'delivery-domain.json',
        value,
        DELIVERY_LIMITS.domainTotalBytes,
        current,
      ),
    )
  }
  private async readDeliveryFile(
    name: 'deliveries.json' | 'delivery-domain.json',
    limit: number,
    absent: unknown,
  ): Promise<unknown> {
    await this.assertWritable()
    try {
      const data = await this.host.readTextFilePrefix(
        joinHostPath(this.stateFile, '..', name),
        limit,
      )
      await this.assertWritable()
      if (!data.complete || data.validUtf8 === false)
        throw new Error('Delivery state exceeds its bound')
      return JSON.parse(data.content) as unknown
    } catch (reason) {
      await this.assertWritable()
      if ((reason as { code?: unknown }).code === 'ENOENT') return absent
      throw new Error('Delivery state cannot be read safely', { cause: reason })
    }
  }
  private async writeDeliveryFile(
    name: 'deliveries.json' | 'delivery-domain.json',
    value: unknown,
    limit: number,
    current: () => void,
  ): Promise<void> {
    await this.assertWritable()
    current()
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > limit)
      throw new Error('Delivery state exceeds its bound')
    await this.host.writeFile(joinHostPath(this.stateFile, '..', name), data, {
      signal: this.authority.signal,
    })
    await this.assertWritable()
    current()
  }

  private presentationFile(): HostPath {
    return joinHostPath(this.stateFile, '..', 'presentation.json')
  }

  private async readPresentationFile(): Promise<Record<string, unknown>> {
    await this.assertWritable()
    try {
      const value = await this.host.readTextFilePrefix(
        this.presentationFile(),
        EXTENSION_LIMITS.presentationTotalBytes,
      )
      if (!value.complete || value.validUtf8 === false)
        throw new Error('Saved presentation exceeds its bound')
      await this.assertWritable()
      const parsed: unknown = JSON.parse(value.content)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      await this.assertWritable()
      return {}
    }
  }

  readPresentation(): Promise<unknown> {
    return this.serialize(() => this.readPresentationFile())
  }

  savePresentation(
    value: Readonly<Record<string, readonly ExtensionItemValue[]>>,
    current: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.serialize(async () => {
      await this.assertWritable()
      current()
      signal.throwIfAborted()
      const retained = Object.fromEntries(
        Object.entries(value).filter(([id]) =>
          this.accepted.some((entry) => entry.installationId === id),
        ),
      )
      await this.host.writeFile(this.presentationFile(), JSON.stringify(retained), {
        signal: AbortSignal.any([this.authority.signal, signal]),
      })
      await this.assertWritable()
      current()
      signal.throwIfAborted()
    })
  }

  dispose(): Promise<void> {
    if (this.stopping) return this.stopping
    this.disposed = true
    this.loseOwnership()
    return (this.stopping = this.pending
      .catch(() => undefined)
      .then(() => this.releaseTask))
  }

  private loseOwnership(): void {
    this.authority.abort()
    const writer = this.writer
    this.writer = undefined
    this.explanation =
      'Extension state write ownership ended. Close this instance or use a separate user-data directory.'
    for (const id of [...this.active.keys()]) this.revokeActivation(id)
    this.publish()
    if (writer)
      this.releaseTask = this.pending.catch(() => undefined).then(() => writer.release())
  }

  private revokeActivation(id: string): void {
    this.agentLifetimes.get(id)?.abort()
    this.agentLifetimes.delete(id)
    this.active.delete(id)
    this.revoke(id)
  }
  private publish(): void {
    this.changed(this.snapshot())
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }
}
