import { createHash, randomUUID } from 'node:crypto'
import { hostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

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
  async acquire(
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
      if (!/^c\.[a-f0-9]{64}$/.test(entry.name) || entry.type !== 'dir')
        throw new Error(
          'hvir-agent cache contains an unrecognized entry; preserve it and inspect the private directory',
        )
      const marker = await this.marker(host, path, signal)
      if (marker.pending) {
        if (
          typeof marker.createdAt !== 'number' ||
          Date.now() - marker.createdAt < 24 * 60 * 60 * 1000
        )
          throw new Error(
            'hvir-agent upload is pending or interrupted; partial clients are never executed',
          )
        await this.retire(host, root, path, marker, signal)
        continue
      }
      retained.push({ path, marker, leased: await this.leased(host, path, signal) })
    }
    let cached = retained.find((entry) => entry.marker.hash === asset.sha256)
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
      const path = joinHostPath(root, `c.${asset.sha256}`)
      await control(host, CREATE_REVISION, [path.path], signal)
      const pending: Marker = {
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
            throw new Error('hvir-agent upload ownership is uncertain; partial preserved')
          const upload = {
            name: temporary.path.slice(temporary.path.lastIndexOf('/') + 1),
            identity: await identity(host, temporary, signal),
          }
          uploadIdentity = upload.identity
          await cache.writeMarker(host, path, { ...pending, upload }, signal)
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
        throw new Error('hvir-agent published client was replaced; it has been preserved')
      const marker: Marker = {
        hash: asset.sha256,
        bytes: asset.bytes.length,
        directory: await identity(host, path, signal),
        client: await identity(host, client, signal),
      }
      await this.writeMarker(host, path, marker, signal)
      await control(host, VERIFY_PUBLICATION, [path.path], signal)
      cached = { path, marker, leased: false }
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
      !path.path.endsWith(`c.${marker.hash}`)
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
        await identity(host, joinHostPath(path, 'owned.json'), signal),
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
async function identity(
  host: ProjectHost,
  path: HostPath,
  signal?: AbortSignal,
): Promise<string> {
  return control(host, `${STAT}\nkey "$1"`, [path.path], signal)
}
async function control(
  host: ProjectHost,
  script: string,
  args: readonly string[],
  parent?: AbortSignal,
): Promise<string> {
  const result = await host.exec(
    'sh',
    ['-c', `set -eu\numask 077\n${script}`, 'hvir-agent-cache', ...args],
    {
      signal: parent
        ? AbortSignal.any([parent, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
      maxBuffer: 8192,
    },
  )
  if (result.code !== 0)
    throw new Error(
      'hvir-agent private cache setup or exact cleanup is unavailable; existing files were preserved',
    )
  return result.stdout.trim()
}
const STAT = String.raw`
key() { stat -c '%u:%d:%i' "$1" 2>/dev/null || stat -f '%u:%d:%i' "$1"; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
private() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ] && [ "$(mode "$1")" = 700 ]; }
`
const PRIVATE_DIRECTORY = `${STAT}\n[ -e "$1" ] || mkdir "$1"\nprivate "$1"`
const DETECT = `${STAT}
safe() { case "$1" in /*) ;; *) return 1;; esac; case "$1" in *[!A-Za-z0-9_./-]*) return 1;; esac; }
uid=$(id -u)
if safe "\${XDG_RUNTIME_DIR-}"; then parent=$XDG_RUNTIME_DIR; base=$parent/hvir
else parent=\${TMPDIR:-/tmp}; safe "$parent" || parent=/tmp; base=$parent/hvir-$uid; fi
[ -d "$parent" ] || exit 70
[ -e "$base" ] || mkdir "$base"
private "$base" || exit 71
uname -s; uname -m; printf '%s\n' "$base"
`
const CREATE_REVISION = `${STAT}\nmkdir "$1"\nprivate "$1"`
const VERIFY_MARKER = `${STAT}\nprivate "$1"\n[ -f "$1/owned.json" ] && [ ! -L "$1/owned.json" ]\n[ "$(owner "$1/owned.json")" = "$(id -u)" ] && [ "$(mode "$1/owned.json")" = 600 ]`
const VERIFY_PUBLICATION = `${STAT}\nprivate "$1"\n[ -f "$1/hvir-agent" ] && [ ! -L "$1/hvir-agent" ]\n[ "$(owner "$1/hvir-agent")" = "$(id -u)" ] && [ "$(mode "$1/hvir-agent")" = 755 ]\n[ -f "$1/owned.json" ] && [ ! -L "$1/owned.json" ]\n[ "$(owner "$1/owned.json")" = "$(id -u)" ] && [ "$(mode "$1/owned.json")" = 600 ]`
const CREATE_LEASE = `${STAT}\n[ ! -e "$1" ]\n(set -C; printf '%s\\n' "$2" > "$1")\n[ "$(mode "$1")" = 600 ]`
const SHORT_SOCKET_BASE = `${STAT}\nbase=/tmp/hvir-$(id -u)\n[ -e "$base" ] || mkdir "$base"\nprivate "$base"\nprintf '%s\\n' "$base"`
const UPDATE_MARKER = `${STAT}\nprivate "$1"\n[ ! -L "$1/owned.json" ] && [ "$(key "$1/owned.json")" = "$2" ] && [ "$(mode "$1/owned.json")" = 600 ]\nprintf '%s' "$3" > "$1/owned.json"`
const CHECK_LEASE = `${STAT}\n[ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ] && [ "$(mode "$1")" = 600 ]`
const UPDATE_LEASE = `${CHECK_LEASE}\n[ "$(key "$1")" = "$2" ]\nprintf '%s' "$3" > "$1"`
const SOCKET_IDENTITY = `${STAT}\n[ -S "$1" ] && [ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ]\nkey "$1"`
const SOCKET_ABSENT = '[ ! -e "$1" ] && [ ! -L "$1" ]'
const REMOVE_EXACT_SOCKET = `${STAT}
[ ! -e "$1" ] && [ ! -L "$1" ] && exit 0
[ -S "$1" ] && [ ! -L "$1" ] && [ "$(key "$1")" = "$2" ] || exit 71
quarantine="$1.retired"
[ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || exit 71
mv "$1" "$quarantine"
[ -S "$quarantine" ] && [ ! -L "$quarantine" ] && [ "$(key "$quarantine")" = "$2" ] || exit 71
rm "$quarantine"`
const REMOVE_EXACT_FILE = `${STAT}\n[ ! -e "$1" ] && exit 0\n[ ! -L "$1" ] && [ "$(key "$1")" = "$2" ] || exit 71\nquarantine="$1.retired"\n[ ! -e "$quarantine" ] || exit 71\nmv "$1" "$quarantine"\n[ "$(key "$quarantine")" = "$2" ] || exit 71\nrm "$quarantine"`
const RETIRE = `${STAT}
private "$1" && private "$2"
[ "$(key "$2")" = "$3" ] && [ "$(key "$2/owned.json")" = "$6" ] || exit 71
check() {
  count=0
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "\${entry##*/}" in
      owned.json) [ ! -L "$entry" ] && [ "$(key "$entry")" = "$6" ] || exit 71;;
      hvir-agent) expected=$4; [ -n "$expected" ] || expected=$8; [ -n "$expected" ] && [ ! -L "$entry" ] && [ "$(key "$entry")" = "$expected" ] || exit 71;;
      upload.*) [ "\${entry##*/}" = "$7" ] && [ -n "$8" ] && [ ! -L "$entry" ] && [ "$(key "$entry")" = "$8" ] || exit 71;;
      *) exit 71;;
    esac
    count=$((count+1))
  done
  [ "$count" -le 2 ] && [ "$count" -ge 1 ]
}
check "$2" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
quarantine="$1/retired.$5"
[ ! -e "$quarantine" ] || exit 71
mv "$2" "$quarantine"
[ "$(key "$quarantine")" = "$3" ] || exit 71
check "$quarantine" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
for entry in "$quarantine"/*; do rm "$entry"; done
rmdir "$quarantine"`
