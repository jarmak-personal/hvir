import { createHash, randomUUID } from 'node:crypto'
import { hostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  identity,
  control,
  DETECT,
  PRIVATE_DIRECTORY,
  CREATE_REVISION,
  VERIFY_MARKER,
  VERIFY_PUBLICATION,
  CREATE_LEASE,
  SHORT_SOCKET_BASE,
  UPDATE_MARKER,
  CHECK_LEASE,
  UPDATE_LEASE,
  SOCKET_IDENTITY,
  SOCKET_ABSENT,
  REMOVE_EXACT_SOCKET,
  REMOVE_EXACT_FILE,
  RETIRE,
} from './remote-client-cache-control'

export const REMOTE_CLIENT_CACHE_LIMITS = {
  revisions: 3,
  bytes: 48 * 1024 * 1024,
  clientBytes: 16 * 1024 * 1024,
  entries: 64,
} as const
export interface RemoteClientAsset {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly target: string
}
export interface CachedRemoteClient {
  readonly client: HostPath
  readonly directory: HostPath
  readonly socket: HostPath
  recordSocket(signal: AbortSignal): Promise<void>
  release(): Promise<void>
}
interface Lease {
  readonly socket: string
  readonly identity?: string
}
interface Marker {
  readonly hash: string
  readonly directory: string
  readonly client: string
  readonly bytes: number
  readonly pending?: boolean
  readonly createdAt?: number
  readonly upload?: { readonly name: string; readonly identity: string }
}

/** Private client files and exact-object retention. All effects stay behind ProjectHost. */
export class RemoteClientCache {
  private readonly acquisitions = new Map<string, Promise<void>>()
  acquire(
    host: ProjectHost,
    base: HostPath,
    asset: RemoteClientAsset,
    instance: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<CachedRemoteClient> {
    const key = JSON.stringify([host.hostId, base.path])
    const work = (this.acquisitions.get(key) ?? Promise.resolve()).then(() => {
      signal.throwIfAborted()
      return this.prepare(host, base, asset, instance, generation, signal)
    })
    // The actual physical operation owns this queue slot until settlement, even after caller timeout.
    const settled = work.then(
      () => undefined,
      () => undefined,
    )
    this.acquisitions.set(key, settled)
    void settled.then(() => {
      if (this.acquisitions.get(key) === settled) this.acquisitions.delete(key)
    })
    return work
  }
  async detect(
    host: ProjectHost,
    signal: AbortSignal,
  ): Promise<{ target: string; base: HostPath }> {
    const value = await control(host, DETECT, [], signal),
      lines = value.split('\n')
    const [os, cpu, path] = lines
    const platform = os === 'Linux' ? 'linux' : os === 'Darwin' ? 'macos' : undefined
    const arch = ['x86_64', 'amd64'].includes(cpu ?? '')
      ? 'x64'
      : ['aarch64', 'arm64'].includes(cpu ?? '')
        ? 'arm64'
        : undefined
    if (!platform || !arch)
      throw new Error('hvir-agent is unavailable: this host OS or CPU is unsupported')
    if (!path || !/^\/[A-Za-z0-9_./-]+$/.test(path))
      throw new Error('hvir-agent private directory is unsafe')
    return { target: `${platform}-${arch}`, base: hostPath(host.hostId, path) }
  }
  private async prepare(
    host: ProjectHost,
    base: HostPath,
    asset: RemoteClientAsset,
    instance: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<CachedRemoteClient> {
    if (
      asset.bytes.length > REMOTE_CLIENT_CACHE_LIMITS.clientBytes ||
      createHash('sha256').update(asset.bytes).digest('hex') !== asset.sha256
    )
      throw new Error('Bundled hvir-agent integrity failed')
    const root = joinHostPath(base, 'agent-client')
    await control(host, PRIVATE_DIRECTORY, [root.path], signal)
    const entries = await host.readdir(root)
    if (entries.length > REMOTE_CLIENT_CACHE_LIMITS.entries)
      throw new Error('hvir-agent cache contains too many entries')
    const retained: { path: HostPath; marker: Marker; leased: boolean }[] = []
    for (const entry of entries) {
      signal.throwIfAborted()
      const path = joinHostPath(root, entry.name)
      if (!/^c\.[a-f0-9]{64}\.[a-f0-9-]{36}$/.test(entry.name) || entry.type !== 'dir')
        throw new Error(
          'hvir-agent cache contains an unrecognized entry; preserve it and inspect the private directory',
        )
      const marker = await this.marker(host, path, signal)
      if (marker.pending) {
        if (
          typeof marker.createdAt === 'number' &&
          Date.now() - marker.createdAt >= 24 * 60 * 60 * 1000
        ) {
          try {
            await this.retire(host, root, path, marker, signal)
            continue
          } catch {
            signal.throwIfAborted()
            // Uncertain/replaced leaves remain charged; they do not deny unrelated revisions.
          }
        }
        retained.push({ path, marker, leased: true })
        continue
      }
      retained.push({ path, marker, leased: await this.leased(host, path, signal) })
    }
    let cached = retained.find(
      (entry) => !entry.marker.pending && entry.marker.hash === asset.sha256,
    )
    let count = retained.length,
      bytes = retained.reduce((sum, entry) => sum + entry.marker.bytes, 0)
    if (!cached) {
      for (const entry of retained) {
        if (
          count < REMOTE_CLIENT_CACHE_LIMITS.revisions &&
          bytes + asset.bytes.length <= REMOTE_CLIENT_CACHE_LIMITS.bytes
        )
          break
        if (entry.leased) continue
        await this.retire(host, root, entry.path, entry.marker, signal)
        count--
        bytes -= entry.marker.bytes
      }
      if (
        count >= REMOTE_CLIENT_CACHE_LIMITS.revisions ||
        bytes + asset.bytes.length > REMOTE_CLIENT_CACHE_LIMITS.bytes
      )
        throw new Error('hvir-agent cache capacity is full; live clients are preserved')
      const path = joinHostPath(root, `c.${asset.sha256}.${randomUUID()}`)
      await control(host, CREATE_REVISION, [path.path], signal)
      let pending: Marker = {
        hash: asset.sha256,
        bytes: asset.bytes.length,
        directory: await identity(host, path, signal),
        client: '',
        pending: true,
        createdAt: Date.now(),
      }
      const temporary = joinHostPath(path, `upload.${randomUUID()}`),
        client = joinHostPath(path, 'hvir-agent')
      await this.writeMarker(host, path, pending, signal)
      const markerIdentity = await identity(
        host,
        joinHostPath(path, 'owned.json'),
        signal,
      )
      try {
        const transfer = host.fileTransfer
        if (!transfer) throw new Error('hvir-agent requires supported SFTP transfer')
        let uploadIdentity: string | undefined
        const assertUpload = async (): Promise<void> => {
          if (
            !uploadIdentity ||
            (await identity(host, temporary, signal)) !== uploadIdentity
          )
            throw new Error('hvir-agent upload was replaced; it has been preserved')
        }
        // Preserve uncertain objects; reconciliation requires exact recorded identities.
        await transfer.writeFileChunksExclusive(
          temporary,
          (async function* (cache: RemoteClientCache) {
            const created = await host.stat(temporary)
            if (created.type !== 'file' || created.size !== 0)
              throw new Error(
                'hvir-agent upload ownership is uncertain; partial preserved',
              )
            const upload = {
              name: temporary.path.slice(temporary.path.lastIndexOf('/') + 1),
              identity: await identity(host, temporary, signal),
            }
            uploadIdentity = upload.identity
            pending = { ...pending, upload }
            await cache.writeMarker(host, path, pending, signal)
            yield* chunks(asset.bytes)
          })(this),
          {
            mode: 0o644,
            signal,
            preserveOnFailure: true,
          },
        )
        await assertUpload()
        await this.digest(host, temporary, asset.sha256, asset.bytes.length, signal)
        await transfer.setMetadata(temporary, {
          mode: 0o755,
          mtimeSeconds: Math.floor(Date.now() / 1000),
          signal,
        })
        await assertUpload()
        await transfer.renameNoReplace(temporary, client, { signal })
        if ((await identity(host, client, signal)) !== uploadIdentity)
          throw new Error(
            'hvir-agent published client was replaced; it has been preserved',
          )
        const marker: Marker = {
          hash: asset.sha256,
          bytes: asset.bytes.length,
          directory: await identity(host, path, signal),
          client: await identity(host, client, signal),
        }
        await this.writeMarker(host, path, marker, signal)
        await control(host, VERIFY_PUBLICATION, [path.path], signal)
        cached = { path, marker, leased: false }
      } catch (reason) {
        // This awaited upload/publication has settled. An aborted preparation cannot cancel cleanup.
        await this.retire(
          host,
          root,
          path,
          pending,
          AbortSignal.timeout(8000),
          markerIdentity,
        ).catch(() => undefined)
        throw reason
      }
    }
    const client = joinHostPath(cached.path, 'hvir-agent')
    await this.digest(host, client, asset.sha256, asset.bytes.length, signal)
    const probe = await host.exec(client.path, ['--hvir-client-probe'], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      maxBuffer: 4096,
    })
    if (probe.code !== 0 || probe.stdout.trim() !== 'hvir-agent transport 1.0')
      throw new Error(
        'hvir-agent cannot execute here: unsupported ABI or a no-exec private directory',
      )
    const name = `a.${instance.slice(0, 8)}.${createHash('sha256').update(generation).digest('hex').slice(0, 12)}.sock`
    let socket = joinHostPath(base, name)
    if (Buffer.byteLength(socket.path) >= 104)
      socket = joinHostPath(
        hostPath(host.hostId, await control(host, SHORT_SOCKET_BASE, [], signal)),
        name,
      )
    if (Buffer.byteLength(socket.path) >= 104)
      throw new Error('hvir-agent socket namespace is too long for this host')
    if ((await host.readdir(cached.path)).length >= REMOTE_CLIENT_CACHE_LIMITS.entries)
      throw new Error(
        'hvir-agent cache lease capacity is full; existing clients are preserved',
      )
    const socketParent = joinHostPath(socket, '..')
    await control(host, PRIVATE_DIRECTORY, [socketParent.path], signal)
    if ((await host.readdir(socketParent)).length >= REMOTE_CLIENT_CACHE_LIMITS.entries)
      throw new Error(
        'hvir-agent socket namespace capacity is full; existing objects are preserved',
      )
    const lease = joinHostPath(cached.path, `lease.${randomUUID()}`)
    await control(
      host,
      CREATE_LEASE,
      [lease.path, JSON.stringify({ socket: socket.path })],
      signal,
    )
    const leaseIdentity = await identity(host, lease, signal)
    let socketIdentity: string | undefined
    return {
      client,
      directory: cached.path,
      socket,
      recordSocket: async (lifetime) => {
        socketIdentity = await control(host, SOCKET_IDENTITY, [socket.path], lifetime)
        await control(
          host,
          UPDATE_LEASE,
          [
            lease.path,
            leaseIdentity,
            JSON.stringify({ socket: socket.path, identity: socketIdentity }),
          ],
          lifetime,
        )
      },
      release: async () => {
        if (socketIdentity)
          await control(host, REMOVE_EXACT_SOCKET, [socket.path, socketIdentity])
        else await control(host, SOCKET_ABSENT, [socket.path])
        await control(host, REMOVE_EXACT_FILE, [lease.path, leaseIdentity])
      },
    }
  }
  private async writeMarker(
    host: ProjectHost,
    path: HostPath,
    marker: Marker,
    signal: AbortSignal,
  ): Promise<void> {
    const file = joinHostPath(path, 'owned.json'),
      text = JSON.stringify(marker)
    if (!host.fileTransfer) throw new Error('hvir-agent requires supported SFTP transfer')
    try {
      await host.stat(file)
    } catch {
      await host.fileTransfer.writeFileChunksExclusive(
        file,
        chunks(new TextEncoder().encode(text)),
        { mode: 0o600, signal, preserveOnFailure: true },
      )
      await control(host, VERIFY_MARKER, [path.path], signal)
      return
    }
    await control(
      host,
      UPDATE_MARKER,
      [path.path, await identity(host, file, signal), text],
      signal,
    )
  }
  private async digest(
    host: ProjectHost,
    path: HostPath,
    expected: string,
    size: number,
    signal: AbortSignal,
  ): Promise<void> {
    const stat = await host.stat(path)
    if (
      stat.type !== 'file' ||
      stat.size !== size ||
      size > REMOTE_CLIENT_CACHE_LIMITS.clientBytes
    )
      throw new Error('hvir-agent client verification failed')
    const hash = createHash('sha256')
    let bytes = 0
    if (!host.fileTransfer) throw new Error('hvir-agent requires supported SFTP reads')
    for await (const chunk of host.fileTransfer.readFileChunks(path, { signal })) {
      bytes += chunk.length
      if (bytes > size) throw new Error('hvir-agent client changed during verification')
      hash.update(chunk)
    }
    if (bytes !== size || hash.digest('hex') !== expected)
      throw new Error('hvir-agent client integrity failed')
  }
  private async marker(
    host: ProjectHost,
    path: HostPath,
    signal: AbortSignal,
  ): Promise<Marker> {
    await control(host, VERIFY_MARKER, [path.path], signal)
    const text = await host.readTextFilePrefix(joinHostPath(path, 'owned.json'), 4096, {
      signal,
    })
    if (!text.complete || text.validUtf8 === false)
      throw new Error('hvir-agent cache marker is invalid')
    const marker = JSON.parse(text.content) as Marker
    if (
      !/^[a-f0-9]{64}$/.test(marker.hash) ||
      !Number.isSafeInteger(marker.bytes) ||
      marker.bytes < 1 ||
      marker.bytes > REMOTE_CLIENT_CACHE_LIMITS.clientBytes ||
      marker.directory !== (await identity(host, path, signal)) ||
      (!marker.pending &&
        marker.client !==
          (await identity(host, joinHostPath(path, 'hvir-agent'), signal))) ||
      !new RegExp(`(?:^|/)c\\.${marker.hash}\\.[a-f0-9-]{36}$`).test(path.path)
    )
      throw new Error('hvir-agent cache object was replaced; it has been preserved')
    if (!marker.pending) await control(host, VERIFY_PUBLICATION, [path.path], signal)
    return marker
  }
  private async leased(
    host: ProjectHost,
    path: HostPath,
    signal: AbortSignal,
  ): Promise<boolean> {
    const entries = await host.readdir(path)
    if (
      entries.length > REMOTE_CLIENT_CACHE_LIMITS.entries ||
      entries.some(
        (entry) =>
          !['hvir-agent', 'owned.json'].includes(entry.name) &&
          !/^lease\.[a-f0-9-]{36}$/.test(entry.name),
      )
    )
      throw new Error(
        'hvir-agent cache contains unknown or interrupted files; they have been preserved',
      )
    for (const entry of entries.filter((entry) => entry.name.startsWith('lease.'))) {
      if (entry.type !== 'file') throw new Error('hvir-agent lease is unsafe')
      const file = joinHostPath(path, entry.name),
        stat = await host.stat(file)
      // Fresh lease markers protect preparation before its socket starts. Older live sockets stay protected.
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) return true
      await control(host, CHECK_LEASE, [file.path], signal)
      const read = await host.readTextFilePrefix(file, 4096, { signal })
      if (!read.complete || read.validUtf8 === false)
        throw new Error('hvir-agent lease is invalid')
      const lease = JSON.parse(read.content) as Lease
      if (
        typeof lease.socket !== 'string' ||
        !/^\/[A-Za-z0-9_./-]+\/a\.[A-Za-z0-9-]+\.[a-f0-9]{12}\.sock$/.test(
          lease.socket,
        ) ||
        Buffer.byteLength(lease.socket) >= 104 ||
        (lease.identity !== undefined && !/^\d+:\d+:\d+$/.test(lease.identity))
      )
        throw new Error('hvir-agent lease ownership is invalid; preserved')
      const probe = await host.exec(
        joinHostPath(path, 'hvir-agent').path,
        ['--hvir-client-probe-socket', lease.socket],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), maxBuffer: 4096 },
      )
      if (probe.code !== 0 || !['live', 'stale'].includes(probe.stdout.trim()))
        throw new Error('hvir-agent cache lease liveness is uncertain; client preserved')
      if (probe.stdout.trim() === 'live') return true
      if (lease.identity)
        await control(host, REMOVE_EXACT_SOCKET, [lease.socket, lease.identity], signal)
      // A never-receipted stale socket is uncertain: preserve its leaf, retire only the owned lease.
      await control(
        host,
        REMOVE_EXACT_FILE,
        [file.path, await identity(host, file, signal)],
        signal,
      )
    }
    return false
  }
  private async retire(
    host: ProjectHost,
    root: HostPath,
    path: HostPath,
    marker: Marker,
    signal: AbortSignal,
    markerIdentity?: string,
  ): Promise<void> {
    await control(
      host,
      RETIRE,
      [
        root.path,
        path.path,
        marker.directory,
        marker.client,
        randomUUID(),
        markerIdentity ??
          (await identity(host, joinHostPath(path, 'owned.json'), signal)),
        marker.upload?.name ?? '',
        marker.upload?.identity ?? '',
      ],
      signal,
    )
  }
}
async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 65536)
    yield await Promise.resolve(bytes.subarray(offset, offset + 65536))
}
