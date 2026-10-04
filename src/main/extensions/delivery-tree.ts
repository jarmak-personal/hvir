import { proveRealProjectDirectory } from '../project-file-operations/project-file-confinement'
import { isProjectFileEntryName } from '../../shared/project-file-operations'
import { createHash } from 'node:crypto'
import {
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import {
  DELIVERY_LIMITS,
  type DeliveryTreeEntry,
} from '../../shared/extensions/managed-delivery'
import type { ProjectHost } from '../project-host/project-host'

export type DeliveryHost = Pick<
  ProjectHost,
  | 'hostId'
  | 'connectionState'
  | 'stat'
  | 'realpath'
  | 'readdir'
  | 'fileTransfer'
  | 'managedTransfer'
  | 'createDirectoryExclusive'
  | 'removeFile'
>
export interface DeliveryTree {
  readonly entries: readonly DeliveryTreeEntry[]
  readonly fingerprint: string
  readonly bytes: number
  readonly data: ReadonlyMap<string, Uint8Array>
}
export function compareDeliveryPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
export function deliveryFingerprint(entries: readonly DeliveryTreeEntry[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([...entries].sort((a, b) => compareDeliveryPaths(a.path, b.path))),
    )
    .digest('hex')
}
/** Complete no-link observation. Domain approval and tree-version hashing are absent. */
export async function readDeliveryTree(
  host: DeliveryHost,
  root: HostPath,
  current: () => void,
  signal: AbortSignal,
  capture = false,
  scopeRoot?: HostPath,
): Promise<DeliveryTree> {
  if (!host.fileTransfer) throw new Error('Host file transfer is unavailable')
  const anchor =
    scopeRoot ?? ((await host.stat(root)).type === 'dir' ? root : dirnameHostPath(root))
  const entries: DeliveryTreeEntry[] = [],
    data = new Map<string, Uint8Array>()
  let bytes = 0
  const walk = async (path: HostPath, relative: string, depth: number): Promise<void> => {
    current()
    signal.throwIfAborted()
    if (depth > DELIVERY_LIMITS.depth || entries.length >= DELIVERY_LIMITS.files)
      throw new Error('Delivery tree exceeds its entry or depth bound')
    if (!hostPathEquals(await host.realpath(anchor), anchor))
      throw new Error('Delivery observation root changed')
    await proveRealProjectDirectory(
      host,
      anchor,
      anchor,
      hostPathEquals(path, anchor) ? anchor : dirnameHostPath(path),
    )
    current()
    signal.throwIfAborted()
    const before = await host.stat(path)
    const mode = before.mode & 0o7777
    if (mode > 0o777 || !['file', 'dir'].includes(before.type))
      throw new Error(
        'Delivery requires ordinary files and directories without special modes or links',
      )
    if (before.type === 'dir') {
      entries.push({ path: relative, type: 'dir', mode, size: 0 })
      const children = await host.readdir(path)
      current()
      signal.throwIfAborted()
      if (children.length > DELIVERY_LIMITS.files)
        throw new Error('Delivery directory exceeds its entry bound')
      for (const child of children.sort((a, b) => compareDeliveryPaths(a.name, b.name))) {
        if (!isProjectFileEntryName(child.name) || child.name.length > 240)
          throw new Error('Delivery has an unsupported filename')
        await walk(
          joinHostPath(path, child.name),
          relative ? `${relative}/${child.name}` : child.name,
          depth + 1,
        )
      }
    } else {
      if (before.size > DELIVERY_LIMITS.fileBytes)
        throw new Error('Delivery file exceeds its byte bound')
      const hash = createHash('sha256'),
        chunks: Buffer[] = []
      let size = 0
      await proveRealProjectDirectory(host, anchor, anchor, dirnameHostPath(path))
      current()
      signal.throwIfAborted()
      for await (const chunk of host.fileTransfer!.readFileChunks(path, { signal })) {
        current()
        signal.throwIfAborted()
        size += chunk.byteLength
        bytes += chunk.byteLength
        if (size > DELIVERY_LIMITS.fileBytes || bytes > DELIVERY_LIMITS.payloadBytes)
          throw new Error('Delivery payload exceeds its byte bound')
        hash.update(chunk)
        if (capture) chunks.push(Buffer.from(chunk))
      }
      if (size !== before.size)
        throw new Error('Delivery source changed during observation')
      entries.push({
        path: relative,
        type: 'file',
        mode,
        size,
        sha256: hash.digest('hex'),
      })
      if (capture) data.set(relative, Buffer.concat(chunks, size))
    }
    const after = await host.stat(path)
    current()
    signal.throwIfAborted()
    if (
      after.type !== before.type ||
      after.mode !== before.mode ||
      (before.type === 'file' &&
        (after.size !== before.size || after.mtimeMs !== before.mtimeMs))
    )
      throw new Error('Delivery tree changed during observation')
  }
  await walk(root, '', 0)
  entries.sort((a, b) => compareDeliveryPaths(a.path, b.path))
  return { entries, fingerprint: deliveryFingerprint(entries), bytes, data }
}

export async function stageDeliveryTree(
  host: DeliveryHost,
  root: HostPath,
  tree: DeliveryTree,
  current: () => void,
  signal: AbortSignal,
  scopeRoot: HostPath,
): Promise<void> {
  if (!host.managedTransfer) throw new Error('Managed transfer is unavailable')
  const created = new Map<string, { path: HostPath; identity: string }>()
  const confined = async (path: HostPath, directory = false): Promise<void> => {
    current()
    signal.throwIfAborted()
    if (!hostPathEquals(await host.realpath(scopeRoot), scopeRoot))
      throw new Error('Delivery staging root changed')
    await proveRealProjectDirectory(
      host,
      scopeRoot,
      scopeRoot,
      directory ? path : dirnameHostPath(path),
    )
    for (const { path: parent, identity } of created.values())
      if (
        (path.path === parent.path || path.path.startsWith(`${parent.path}/`)) &&
        (await host.managedTransfer!.entryIdentity(parent, signal)) !== identity
      )
        throw new Error('Created delivery parent identity changed')
    current()
    signal.throwIfAborted()
  }
  for (const entry of [...tree.entries].sort(
    (a, b) =>
      a.path.split('/').length - b.path.split('/').length ||
      compareDeliveryPaths(a.path, b.path),
  )) {
    current()
    signal.throwIfAborted()
    const path = entry.path ? joinHostPath(root, entry.path) : root
    await confined(path)
    if (entry.type === 'dir') {
      await host.createDirectoryExclusive(path, { mode: 0o755, signal })
      created.set(path.path, {
        path,
        identity: await host.managedTransfer.entryIdentity(path, signal),
      })
    } else {
      const bytes = tree.data.get(entry.path)
      if (!bytes) throw new Error('Captured delivery file is unavailable')
      await host.managedTransfer.writeFileChunksExclusive(
        path,
        (async function* () {
          for (let offset = 0; offset < bytes.length; offset += 65536)
            yield await Promise.resolve(bytes.subarray(offset, offset + 65536))
        })(),
        { mode: entry.mode, signal, preserveOnFailure: true },
      )
    }
  }
  for (const entry of [...tree.entries]
    .filter((entry) => entry.type === 'dir')
    .reverse()) {
    current()
    signal.throwIfAborted()
    const path = entry.path ? joinHostPath(root, entry.path) : root
    await confined(path, true)
    await host.managedTransfer.setMetadata(path, {
      mode: entry.mode,
      mtimeSeconds: Math.floor((await host.stat(path)).mtimeMs / 1000),
      signal,
    })
  }
  current()
  signal.throwIfAborted()
  if (
    (await readDeliveryTree(host, root, current, signal, false, scopeRoot))
      .fingerprint !== tree.fingerprint
  )
    throw new Error('Staged delivery does not match the complete captured tree')
}
