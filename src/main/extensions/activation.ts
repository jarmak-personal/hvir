import { randomUUID } from 'node:crypto'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
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
  private restoring = true
  private disposed = false
  private pending: Promise<unknown> = Promise.resolve()
  private releaseTask: Promise<void> = Promise.resolve()
  private stopping?: Promise<void>
  private readonly authority = new AbortController()

  constructor(
    private readonly host: ProjectHost,
    readonly directory: HostPath,
    private readonly stateFile: HostPath,
    readonly packages: ExtensionPackageStore,
    private readonly revoke: (installationId: string) => void,
    private readonly changed: (state: ExtensionPlatformState) => void,
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

  private async scan(): Promise<ExtensionPlatformState> {
    if (this.disposed) throw new Error('Extensions have stopped')
    const entries = await this.host.extensionStorage!.installationNames(
      this.directory,
      EXTENSION_LIMITS.installations * 2,
    )
    this.discovered.clear()
    this.sourceIdentities.clear()
    this.installations = []
    if (
      entries.filter((name) => !name.startsWith('.')).length >
      EXTENSION_LIMITS.installations
    ) {
      this.installations = [
        {
          source: 'extensions',
          warnings: [],
          enabled: false,
          error: `Keep at most ${EXTENSION_LIMITS.installations} packages in the extensions folder`,
        },
      ]
      this.publish()
      return this.snapshot()
    }
    for (const name of [...entries].sort()) {
      if (name.startsWith('.')) continue
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
          : 'Package is missing. Reinstall it and explicitly enable its revision.',
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
    this.publish()
    return this.snapshot()
  }

  enable(source: string, expectedRevision: string): Promise<ExtensionPlatformState> {
    return this.acceptRevision(source, expectedRevision, false)
  }

  reload(source: string, expectedRevision: string): Promise<ExtensionPlatformState> {
    return this.acceptRevision(source, expectedRevision, true)
  }

  private acceptRevision(
    source: string,
    expectedRevision: string,
    replacing: boolean,
  ): Promise<ExtensionPlatformState> {
    return this.serialize(async () => {
      await this.assertWritable()
      const discovered = this.discovered.get(source)
      if (!discovered || (!replacing && discovered.hash !== expectedRevision))
        throw new Error('Discover this package again before accepting it')
      const current = await this.packages.captureSource(
        joinHostPath(this.directory, source),
        this.authority.signal,
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
        throw new Error(
          'Remove unused installation state before accepting another package',
        )
      await this.collect(current)
      await this.packages.retain(current, this.authority.signal)
      await this.assertWritable()
      const record: AcceptedInstallation = {
        installationId: prior?.installationId ?? randomUUID(),
        packageId: current.manifest.id,
        source,
        sourceIdentity: current.sourceIdentity,
        kind: current.kind,
        revision: current.hash,
        enabled: true,
      }
      if (prior) this.revokeActivation(prior.installationId)
      await this.save([...this.accepted.filter((entry) => entry !== prior), record])
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
    })
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
          staging: `.remove-${randomUUID()}`,
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
  ): Promise<void> {
    await this.assertWritable()
    await this.host.writeFile(
      this.stateFile,
      JSON.stringify({ installations: next, removals }),
      {
        signal: this.authority.signal,
      },
    )
    await this.assertWritable()
    this.accepted = next
    this.removals = removals
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
