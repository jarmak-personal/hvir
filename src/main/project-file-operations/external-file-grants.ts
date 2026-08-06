import { randomUUID } from 'node:crypto'

import {
  basenameHostPath,
  containsHostPath,
  hostPath,
  isProjectFileEntryName,
  MAX_EXTERNAL_FILE_SOURCES,
  type ExternalFileGrantResult,
  type ExternalFileGrantPurpose,
  type DirEntry,
  type HostPath,
  type Stat,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import { isMissingProjectPathError } from './project-file-path-errors'
import { PROJECT_FILE_OPERATION_DEADLINE_MS } from './project-file-operation-runtime'

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

interface ExternalFileGrantUseBase {
  readonly grantId: string
  readonly generation: number
  readonly owner: RendererOwner
  readonly purpose: ExternalFileGrantPurpose
  readonly items: readonly GrantedExternalFileItem[]
  source(itemId: string): ExternalFileGrantSourcePort
  assertCurrent(): void
  revoke(): void
}

export interface ExternalFileCopyGrantUse extends ExternalFileGrantUseBase {
  readonly purpose: 'copy'
}

export interface ExternalFileMoveGrantUse extends ExternalFileGrantUseBase {
  readonly purpose: 'move'
  trashSource(
    itemId: string,
    options: {
      readonly signal: AbortSignal
      readonly onSubmitted: () => void
      readonly confirmExpectedSource: () => Promise<boolean>
    },
  ): Promise<'removed' | 'retained' | 'unknown'>
}

export type ExternalFileGrantUse = ExternalFileCopyGrantUse | ExternalFileMoveGrantUse

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
  readonly purpose: ExternalFileGrantPurpose
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
      readonly moveGrantTtlMs?: number
    },
  ) {}

  async acquire(
    owner: RendererOwner,
    rawPaths: readonly string[],
    purpose: ExternalFileGrantPurpose = 'copy',
  ): Promise<ExternalFileGrantResult> {
    if (this.disposed) throw new Error('External file grants are disposed')
    if (purpose === 'move' && !this.supportsExternalMove) {
      throw new Error('Recoverable application-host Trash is unavailable')
    }
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
      throw new Error(
        `The external file list exceeds the ${MAX_EXTERNAL_FILE_SOURCES}-entry limit`,
      )
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
      purpose === 'move'
        ? (this.options.moveGrantTtlMs ?? PROJECT_FILE_OPERATION_DEADLINE_MS)
        : (this.options.grantTtlMs ?? EXTERNAL_FILE_GRANT_TTL_MS),
    )
    const record: GrantRecord = {
      grantId,
      generation,
      owner,
      purpose,
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
  ): ExternalFileCopyGrantUse
  consume(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: 'copy',
  ): ExternalFileCopyGrantUse
  consume(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: 'move',
  ): ExternalFileMoveGrantUse
  consume(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: ExternalFileGrantPurpose = 'copy',
  ): ExternalFileGrantUse {
    const record = this.availableGrant(owner, grantId, generation, purpose)
    record.consumed = true
    clearTimeout(record.timer)
    record.lease.release()
    if (this.ownerGrants.get(ownerKey(owner)) === record) {
      this.ownerGrants.delete(ownerKey(owner))
    }
    const use: ExternalFileGrantUseBase = {
      grantId,
      generation,
      owner,
      purpose: record.purpose,
      items: record.items,
      source: (itemId) => this.sourcePort(record, itemId),
      assertCurrent: () => {
        if (record.revoked || !this.options.resources.isRendererCurrent(record.owner)) {
          throw new Error('The external file grant was revoked')
        }
      },
      revoke: () => this.revoke(record),
    }
    return record.purpose === 'move'
      ? {
          ...use,
          purpose: 'move',
          trashSource: (itemId, options) => this.trashSource(record, itemId, options),
        }
      : { ...use, purpose: 'copy' }
  }

  availableItemCount(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: ExternalFileGrantPurpose,
  ): number {
    return this.availableGrant(owner, grantId, generation, purpose).items.length
  }

  get supportsExternalMove(): boolean {
    return this.options.sourceHost.fileDeletion.capability === 'recoverable'
  }

  release(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: ExternalFileGrantPurpose,
  ): boolean {
    const record = this.grants.get(grantId)
    if (
      !record ||
      record.revoked ||
      record.consumed ||
      record.generation !== generation ||
      record.purpose !== purpose ||
      !sameOwner(record.owner, owner)
    ) {
      return false
    }
    this.revoke(record)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const grant of [...this.grants.values()]) this.revoke(grant)
  }

  private availableGrant(
    owner: RendererOwner,
    grantId: string,
    generation: number,
    purpose: ExternalFileGrantPurpose,
  ): GrantRecord {
    const record = this.grants.get(grantId)
    if (
      !record ||
      record.revoked ||
      record.consumed ||
      record.generation !== generation ||
      record.purpose !== purpose ||
      !sameOwner(record.owner, owner) ||
      !this.options.resources.isRendererCurrent(owner)
    ) {
      throw new Error('The external file grant is unavailable or expired')
    }
    return record
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

  private async trashSource(
    record: GrantRecord,
    itemId: string,
    options: {
      readonly signal: AbortSignal
      readonly onSubmitted: () => void
      readonly confirmExpectedSource: () => Promise<boolean>
    },
  ): Promise<'removed' | 'retained' | 'unknown'> {
    if (record.purpose !== 'move') {
      throw new Error('This external file grant cannot remove its source')
    }
    const item = record.items.find((candidate) => candidate.itemId === itemId)
    if (!item?.source || item.type === 'unsupported') {
      throw new Error('The external file item has no source removal authority')
    }
    if (record.revoked || !this.options.resources.isRendererCurrent(record.owner)) {
      throw new Error('The external file grant was revoked')
    }
    const deletion = this.options.sourceHost.fileDeletion
    if (deletion.capability !== 'recoverable') {
      throw new Error('Recoverable application-host Trash is unavailable')
    }
    options.signal.throwIfAborted()
    let submitted = false
    try {
      await deletion.trashEntry(item.source, {
        signal: options.signal,
        onSubmitted: () => {
          submitted = true
          options.onSubmitted()
        },
      })
    } catch (reason) {
      if (!submitted) throw reason
      try {
        await this.options.sourceHost.stat(item.source)
        return (await options.confirmExpectedSource()) ? 'retained' : 'unknown'
      } catch {
        return 'unknown'
      }
    }
    try {
      await this.options.sourceHost.stat(item.source)
      // A resolved Trash request followed by a present path may be a replacement.
      return 'unknown'
    } catch (reason) {
      return isMissingProjectPathError(reason) ? 'removed' : 'unknown'
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
