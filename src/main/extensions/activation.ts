import { randomUUID } from 'node:crypto'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
} from '../../shared/extensions/workbench'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { ExtensionPackageStore, type ExtensionRevision } from './package-store'
import type { ExtensionWriterLease } from '../project-host/extension-storage-port'

interface AcceptedInstallation {
  readonly installationId: string
  readonly source: string
  readonly sourceIdentity: string
  readonly revision: string
  readonly enabled: boolean
}

export interface ExtensionActivation {
  readonly installationId: string
  readonly generation: string
  readonly revision: ExtensionRevision
}

/** Authority-bearing package state. Discovery executes nothing and never changes an activation. */
export class ExtensionActivationOwner {
  readonly active = new Map<string, ExtensionActivation>()
  private accepted: AcceptedInstallation[] = []
  private discovered = new Map<string, ExtensionRevision>()
  private installations: ExtensionInstallation[] = []
  private writer?: ExtensionWriterLease
  private explanation?: string
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

  async start(lock: HostPath): Promise<void> {
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
      const value: unknown = JSON.parse(workload.content)
      if (!Array.isArray(value) || value.length > EXTENSION_LIMITS.installations)
        throw new Error('Invalid extension state')
      this.accepted = value.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object')
          throw new Error('Invalid extension state')
        const item = entry as Record<string, unknown>
        if (
          typeof item['installationId'] !== 'string' ||
          !/^[a-f0-9-]{36}$/u.test(item['installationId']) ||
          typeof item['source'] !== 'string' ||
          !/^[^/\\.][^/\\]{0,119}$/u.test(item['source']) ||
          typeof item['sourceIdentity'] !== 'string' ||
          !/^\d+:\d+$/u.test(item['sourceIdentity']) ||
          typeof item['revision'] !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(item['revision']) ||
          typeof item['enabled'] !== 'boolean'
        )
          throw new Error('Invalid extension state')
        return {
          installationId: item['installationId'],
          source: item['source'],
          sourceIdentity: item['sourceIdentity'],
          revision: item['revision'],
          enabled: item['enabled'],
        }
      })
      if (
        new Set(this.accepted.map((entry) => entry.source)).size !==
          this.accepted.length ||
        new Set(this.accepted.map((entry) => entry.installationId)).size !==
          this.accepted.length
      )
        throw new Error('Duplicated extension state identity')
    } catch (reason) {
      if ((reason as { code?: unknown }).code !== 'ENOENT') {
        this.explanation =
          'Extension state cannot be read safely. Ordinary workbench features remain available; repair the extension state file before enabling packages.'
        await this.writer.release()
        this.writer = undefined
        return
      }
    }
    await this.discover()
    for (const saved of this.accepted.filter((entry) => entry.enabled)) {
      const source = this.discovered.get(saved.source)
      if (!source || source.sourceIdentity !== saved.sourceIdentity) continue
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
    this.publish()
  }

  snapshot(): ExtensionPlatformState {
    return {
      writable: !!this.writer && !this.disposed,
      ...(this.explanation ? { explanation: this.explanation } : {}),
      installations: this.installations.map((entry) => {
        const accepted = this.accepted.find((item) => item.source === entry.source)
        return {
          ...entry,
          ...(accepted && this.active.get(accepted.installationId)
            ? { manifest: this.active.get(accepted.installationId)!.revision.manifest }
            : {}),
          installationId: accepted?.installationId,
          acceptedRevision: accepted?.revision,
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
      EXTENSION_LIMITS.installations,
    )
    this.discovered.clear()
    this.installations = []
    if (entries.length > EXTENSION_LIMITS.installations) {
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
        const entry = await this.host.stat(joinHostPath(this.directory, name))
        if (entry.type !== 'dir')
          throw new Error('Use an ordinary unpacked directory, without links')
        const revision = await this.packages.capture(joinHostPath(this.directory, name))
        this.discovered.set(name, revision)
        this.installations.push({
          source: name,
          manifest: revision.manifest,
          revision: revision.hash,
          warnings: revision.warnings,
          enabled: false,
        })
      } catch (reason) {
        this.installations.push({
          source: name,
          warnings: [],
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
      if (!accepted || !source || source.sourceIdentity !== accepted.sourceIdentity)
        this.revokeActivation(id)
    }
    this.publish()
    return this.snapshot()
  }

  enable(source: string, expectedRevision: string): Promise<ExtensionPlatformState> {
    return this.serialize(async () => {
      await this.assertWritable()
      const discovered = this.discovered.get(source)
      if (!discovered || discovered.hash !== expectedRevision)
        throw new Error('Discover this package again before enabling it')
      const current = await this.packages.capture(joinHostPath(this.directory, source))
      if (
        current.hash !== discovered.hash ||
        current.sourceIdentity !== discovered.sourceIdentity
      )
        throw new Error('The package changed; discover it and inspect its access again')
      const prior = this.accepted.find((entry) => entry.source === source)
      const record: AcceptedInstallation = {
        installationId:
          prior?.sourceIdentity === current.sourceIdentity
            ? prior.installationId
            : randomUUID(),
        source,
        sourceIdentity: current.sourceIdentity,
        revision: current.hash,
        enabled: true,
      }
      if (prior && this.active.has(prior.installationId))
        throw new Error('Disable this extension before enabling the new revision')
      await this.packages.retain(current, this.authority.signal)
      await this.assertWritable()
      const next = [...this.accepted.filter((entry) => entry.source !== source), record]
      await this.host.writeFile(this.stateFile, JSON.stringify(next), {
        signal: this.authority.signal,
      })
      await this.assertWritable()
      this.accepted = next
      this.active.set(record.installationId, {
        installationId: record.installationId,
        generation: randomUUID(),
        revision: current,
      })
      this.publish()
      return this.snapshot()
    })
  }

  disable(installationId: string): Promise<ExtensionPlatformState> {
    return this.serialize(async () => {
      await this.assertWritable()
      this.revokeActivation(installationId)
      const next = this.accepted.map((entry) =>
        entry.installationId === installationId ? { ...entry, enabled: false } : entry,
      )
      await this.host.writeFile(this.stateFile, JSON.stringify(next), {
        signal: this.authority.signal,
      })
      await this.assertWritable()
      this.accepted = next
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
