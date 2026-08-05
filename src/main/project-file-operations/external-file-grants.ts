import { randomUUID } from 'node:crypto'

import {
  basenameHostPath,
  containsHostPath,
  hostPath,
  isProjectFileEntryName,
  type ExternalFileGrantResult,
  type DirEntry,
  type HostPath,
  type Stat,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import { MAX_EXTERNAL_FILE_SOURCES } from './clipboard-file-list'

const EXTERNAL_FILE_GRANT_TTL_MS = 60_000

export interface ExternalFileGrantResourceLease {
  release(): void
}

export interface ExternalFileGrantResourcePort {
  isRendererCurrent(owner: RendererOwner): boolean
  registerGrant(
    owner: RendererOwner,
    grantId: string,
    revoke: () => void,
  ): ExternalFileGrantResourceLease
}

export interface GrantedExternalFileItem {
  readonly itemId: string
  readonly name: string
  readonly type: 'file' | 'directory' | 'unsupported'
  readonly source?: HostPath
  readonly initialStat?: Stat
  readonly reason?: string
}

export interface ExternalFileGrantUse {
  readonly grantId: string
  readonly generation: number
  readonly owner: RendererOwner
  readonly items: readonly GrantedExternalFileItem[]
  source(itemId: string): ExternalFileGrantSourcePort
  assertCurrent(): void
  revoke(): void
}

/** Exact selected-root read authority; no arbitrary application-host methods escape. */
export interface ExternalFileGrantSourcePort {
  stat(path: HostPath): Promise<Stat>
  readdir(path: HostPath): Promise<readonly DirEntry[]>
  readFileChunks(path: HostPath, signal: AbortSignal): AsyncIterable<Uint8Array>
}

interface GrantRecord {
  readonly grantId: string
  readonly generation: number
  readonly owner: RendererOwner
  readonly items: readonly GrantedExternalFileItem[]
  readonly lease: ExternalFileGrantResourceLease
  readonly timer: ReturnType<typeof setTimeout>
  consumed: boolean
  revoked: boolean
}

/** Main-owned, renderer-scoped authority for exact application-host sources. */
export class ExternalFileGrantRegistry {
  private readonly grants = new Map<string, GrantRecord>()
  private readonly ownerGrants = new Map<string, GrantRecord>()
  private generation = 0
  private disposed = false

  constructor(
    private readonly options: {
      readonly sourceHost: ProjectHost
      readonly registeredRoots: () => readonly HostPath[]
      readonly resources: ExternalFileGrantResourcePort
      readonly createGrantId?: () => string
      readonly grantTtlMs?: number
    },
  ) {}

  async acquire(
    owner: RendererOwner,
    rawPaths: readonly string[],
  ): Promise<ExternalFileGrantResult> {
    if (this.disposed) throw new Error('External file grants are disposed')
    if (!this.options.resources.isRendererCurrent(owner)) {
      throw new Error('The renderer owner is no longer current')
    }
    if (rawPaths.length === 0) {
      return {
        outcome: 'unsupported',
        reason: 'No disk-backed file entries are available',
      }
    }
    if (rawPaths.length > MAX_EXTERNAL_FILE_SOURCES) {
      throw new Error('The external file list exceeds the 256-entry limit')
    }
    const canonicalProjectRoots = await this.canonicalProjectRoots()
    const items = await Promise.all(
      rawPaths.map((path, index) =>
        this.inspectSource(path, index, canonicalProjectRoots),
      ),
    )
    if (!this.options.resources.isRendererCurrent(owner)) {
      throw new Error('The renderer owner is no longer current')
    }
    this.revoke(this.ownerGrants.get(ownerKey(owner)))
    const grantId = this.options.createGrantId?.() ?? randomUUID()
    const generation = (this.generation += 1)
    const revoke = () => this.revoke(this.grants.get(grantId))
    const lease = this.options.resources.registerGrant(owner, grantId, () => revoke())
    const timer = setTimeout(
      revoke,
      this.options.grantTtlMs ?? EXTERNAL_FILE_GRANT_TTL_MS,
    )
    const record: GrantRecord = {
      grantId,
      generation,
      owner,
      items,
      lease,
      timer,
      consumed: false,
      revoked: false,
    }
    this.grants.set(grantId, record)
    this.ownerGrants.set(ownerKey(owner), record)
    return {
      outcome: 'available',
      grant: {
        grantId,
        generation,
        items: items.map(({ itemId, name, type, reason }) => ({
          itemId,
          name,
          type,
          ...(reason ? { reason } : {}),
        })),
      },
    }
  }

  consume(
    owner: RendererOwner,
    grantId: string,
    generation: number,
  ): ExternalFileGrantUse {
    const record = this.grants.get(grantId)
    if (
      !record ||
      record.revoked ||
      record.consumed ||
      record.generation !== generation ||
      !sameOwner(record.owner, owner) ||
      !this.options.resources.isRendererCurrent(owner)
    ) {
      throw new Error('The external file grant is unavailable or expired')
    }
    record.consumed = true
    clearTimeout(record.timer)
    record.lease.release()
    if (this.ownerGrants.get(ownerKey(owner)) === record) {
      this.ownerGrants.delete(ownerKey(owner))
    }
    return {
      grantId,
      generation,
      owner,
      items: record.items,
      source: (itemId) => this.sourcePort(record, itemId),
      assertCurrent: () => {
        if (record.revoked || !this.options.resources.isRendererCurrent(record.owner)) {
          throw new Error('The external file grant was revoked')
        }
      },
      revoke: () => this.revoke(record),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const grant of [...this.grants.values()]) this.revoke(grant)
  }

  private async canonicalProjectRoots(): Promise<readonly HostPath[]> {
    const roots = this.options
      .registeredRoots()
      .filter((root) => root.hostId === this.options.sourceHost.hostId)
    return Promise.all(roots.map((root) => this.options.sourceHost.realpath(root)))
  }

  private sourcePort(record: GrantRecord, itemId: string): ExternalFileGrantSourcePort {
    const item = record.items.find((candidate) => candidate.itemId === itemId)
    if (!item?.source || item.type === 'unsupported') {
      throw new Error('The external file item has no source authority')
    }
    const assertPath = (path: HostPath): void => {
      if (
        record.revoked ||
        !this.options.resources.isRendererCurrent(record.owner) ||
        !containsHostPath(item.source!, path)
      ) {
        throw new Error('The external file source authority was revoked or escaped')
      }
    }
    return {
      stat: (path) => {
        assertPath(path)
        return this.options.sourceHost.stat(path)
      },
      readdir: async (path) => {
        assertPath(path)
        if ((await this.options.sourceHost.stat(path)).type !== 'dir') {
          throw new Error('External traversal requires a real directory')
        }
        return this.options.sourceHost.readdir(path)
      },
      readFileChunks: (path, signal) => {
        assertPath(path)
        const transfer = this.options.sourceHost.fileTransfer
        if (!transfer) throw new Error('Application-host streaming is unavailable')
        const host = this.options.sourceHost
        return (async function* (): AsyncIterable<Uint8Array> {
          assertPath(path)
          if ((await host.stat(path)).type !== 'file') {
            throw new Error('External streaming requires a real regular file')
          }
          for await (const chunk of transfer.readFileChunks(path, { signal })) {
            assertPath(path)
            yield chunk
          }
          assertPath(path)
          if ((await host.stat(path)).type !== 'file') {
            throw new Error('The external source changed during streaming')
          }
        })()
      },
    }
  }

  private async inspectSource(
    rawPath: string,
    index: number,
    projectRoots: readonly HostPath[],
  ): Promise<GrantedExternalFileItem> {
    const itemId = `external:${index}`
    const fallbackName = `Unsupported entry ${index + 1}`
    if (
      typeof rawPath !== 'string' ||
      rawPath.length === 0 ||
      rawPath.length > 16_384 ||
      !rawPath.startsWith('/') ||
      rawPath.includes('\0') ||
      rawPath.includes('//') ||
      (rawPath !== '/' && rawPath.endsWith('/')) ||
      rawPath.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      return unsupported(itemId, fallbackName, 'The source path is invalid')
    }
    const requested = hostPath(this.options.sourceHost.hostId, rawPath)
    const displayName = basenameHostPath(requested)
    if (
      !isProjectFileEntryName(displayName) ||
      Buffer.byteLength(displayName, 'utf8') > 255
    ) {
      return unsupported(
        itemId,
        fallbackName,
        'The source name is invalid or exceeds the filename limit',
      )
    }
    try {
      const requestedStat = await this.options.sourceHost.stat(requested)
      if (requestedStat.type === 'symlink') {
        return unsupported(itemId, displayName, 'Symbolic links are not supported')
      }
      if (requestedStat.type !== 'file' && requestedStat.type !== 'dir') {
        return unsupported(itemId, displayName, 'This filesystem entry is unsupported')
      }
      const canonical = await this.options.sourceHost.realpath(requested)
      if (
        projectRoots.some(
          (root) =>
            containsHostPath(root, canonical) || containsHostPath(canonical, root),
        )
      ) {
        return unsupported(
          itemId,
          displayName,
          'Sources inside or containing a registered project are not supported',
        )
      }
      const canonicalStat = await this.options.sourceHost.stat(canonical)
      if (canonicalStat.type !== requestedStat.type) {
        return unsupported(itemId, displayName, 'The source changed during acquisition')
      }
      return {
        itemId,
        name: displayName,
        type: canonicalStat.type === 'dir' ? 'directory' : 'file',
        source: canonical,
        initialStat: canonicalStat,
      }
    } catch {
      return unsupported(itemId, displayName, 'The source is unavailable')
    }
  }

  private revoke(record: GrantRecord | undefined): void {
    if (!record || record.revoked) return
    record.revoked = true
    clearTimeout(record.timer)
    record.lease.release()
    this.grants.delete(record.grantId)
    if (this.ownerGrants.get(ownerKey(record.owner)) === record) {
      this.ownerGrants.delete(ownerKey(record.owner))
    }
  }
}

function unsupported(
  itemId: string,
  name: string,
  reason: string,
): GrantedExternalFileItem {
  return { itemId, name, type: 'unsupported', reason: reason.slice(0, 240) }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
