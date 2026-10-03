import { createHash } from 'node:crypto'
import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import { RemoteClientCache } from '../src/main/agent/remote-client-cache'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-cache-')),
    host = new LocalHost(),
    cache = new RemoteClientCache()
  await chmod(directory, 0o700)
  cleanups.push(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const asset = (version = 'one') => {
    const bytes = Buffer.from(
      `#!/bin/sh\n# ${version}\ncase "$1" in --hvir-client-probe) printf 'hvir-agent transport 1.0\\n';; --hvir-client-probe-socket) printf stale;; *) exit 69;; esac\n`,
    )
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      target: 'macos-arm64',
    }
  }
  const acquire = (value = asset()) =>
    cache.acquire(
      host,
      localPath(directory),
      value,
      'instance',
      'host-object:1',
      new AbortController().signal,
    )
  return { directory, host, cache, asset, acquire }
}
it('publishes verified private files, reuses one upload, and bounds unleased revisions', async () => {
  const f = await fixture(),
    upload = vi.spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
  const a = await f.acquire(),
    b = await f.acquire()
  expect(a.client).toEqual(b.client)
  expect(
    upload.mock.calls.filter(([path]) => path.path.includes('/upload.')),
  ).toHaveLength(1)
  expect(
    upload.mock.calls.find(([path]) => path.path.endsWith('/owned.json'))?.[2].mode,
  ).toBe(0o600)
  await a.release()
  await b.release()
  for (const version of ['two', 'three', 'four'])
    await (await f.acquire(f.asset(version))).release()
  expect(await readdir(join(f.directory, 'agent-client'))).toHaveLength(3)
})
it('recovers exact interrupted upload and publication objects without executing a partial client', async () => {
  for (const publication of [false, true]) {
    const f = await fixture(),
      original = f.host.fileTransfer.writeFileChunksExclusive.bind(f.host.fileTransfer)
    const spy = vi.spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
    if (!publication)
      spy
        .mockImplementationOnce((path, chunks, options) =>
          original(path, chunks, options),
        )
        .mockImplementationOnce((path, chunks, options) =>
          original(
            path,
            (async function* () {
              for await (const chunk of chunks) {
                yield chunk.subarray(0, 8)
                throw new Error('interrupted')
              }
            })(),
            options,
          ),
        )
    else {
      const renameOriginal = f.host.fileTransfer.renameNoReplace.bind(f.host.fileTransfer)
      vi.spyOn(f.host.fileTransfer, 'renameNoReplace').mockImplementationOnce(
        async (...args) => {
          await renameOriginal(...args)
          throw new Error('publication interrupted')
        },
      )
    }
    await expect(f.acquire()).rejects.toThrow('interrupted')
    spy.mockRestore()
    if (publication) vi.restoreAllMocks()
    const path = join(f.directory, 'agent-client', `c.${f.asset().sha256}`, 'owned.json'),
      marker = JSON.parse(await readFile(path, 'utf8')) as {
        pending: boolean
        createdAt: number
        upload: { name: string; identity: string }
      }
    expect(marker.pending).toBe(true)
    expect(marker.upload.identity).toMatch(/^\d+:\d+:\d+$/)
    await writeFile(
      path,
      JSON.stringify({ ...marker, createdAt: Date.now() - 86_400_001 }),
    )
    const recovered = await f.acquire()
    expect(await readFile(recovered.client.path)).toEqual(f.asset().bytes)
    await recovered.release()
  }
})
it('preserves an externally replaced upload leaf during stale cleanup', async () => {
  const f = await fixture(),
    original = f.host.fileTransfer.writeFileChunksExclusive.bind(f.host.fileTransfer)
  const spy = vi
    .spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
    .mockImplementationOnce((...args) => original(...args))
    .mockImplementationOnce((path, chunks, options) =>
      original(
        path,
        (async function* () {
          for await (const chunk of chunks) {
            yield chunk.subarray(0, 8)
            throw new Error('interrupted')
          }
        })(),
        options,
      ),
    )
  await expect(f.acquire()).rejects.toThrow('interrupted')
  spy.mockRestore()
  const directory = join(f.directory, 'agent-client', `c.${f.asset().sha256}`),
    path = join(directory, 'owned.json'),
    marker = JSON.parse(await readFile(path, 'utf8')) as {
      pending: boolean
      createdAt: number
      upload: { name: string; identity: string }
    },
    upload = join(directory, marker.upload.name)
  await rename(upload, upload + '.original')
  await writeFile(upload, 'foreign')
  await writeFile(path, JSON.stringify({ ...marker, createdAt: Date.now() - 86_400_001 }))
  await expect(f.acquire()).rejects.toThrow('preserved')
  expect(await readFile(upload, 'utf8')).toBe('foreign')
})
it('preserves live leases, reconciles old dead sockets by actual transport probe, and uses a short socket namespace', async () => {
  const f = await fixture(),
    clients = []
  for (const version of ['one', 'two', 'three'])
    clients.push(await f.acquire(f.asset(version)))
  await expect(f.acquire(f.asset('four'))).rejects.toThrow('capacity')
  for (const client of clients) {
    const lease = (await readdir(client.directory.path)).find((name) =>
      name.startsWith('lease.'),
    )!
    const { utimes } = await import('node:fs/promises')
    await utimes(join(client.directory.path, lease), 0, 0)
  }
  const next = await f.acquire(f.asset('four'))
  await next.release()
  const long = join(f.directory, 'long'.repeat(24))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(long, { mode: 0o700 })
  const short = await f.cache.acquire(
    f.host,
    localPath(long),
    f.asset(),
    'instance',
    'host-object:1',
    new AbortController().signal,
  )
  expect(Buffer.byteLength(short.socket.path)).toBeLessThan(104)
  expect(short.directory.path).toContain(long)
  await short.release()
}, 20_000)
it('preserves a leaf replaced after quarantine starts instead of deleting an external object', async () => {
  const f = await fixture()
  for (const version of ['one', 'two', 'three'])
    await (await f.acquire(f.asset(version))).release()
  const original = f.host.exec.bind(f.host)
  let replaced = false
  vi.spyOn(f.host, 'exec').mockImplementation((command, args, options) => {
    if (!replaced && args[1]?.includes('quarantine="$1/retired.$5"')) {
      replaced = true
      const replacement = args[1].replace(
        'mv "$2" "$quarantine"',
        'mv "$2" "$quarantine"\nmv "$quarantine/hvir-agent" "$quarantine/original"\nprintf foreign > "$quarantine/hvir-agent"',
      )
      return original(command, [args[0]!, replacement, ...args.slice(2)], options)
    }
    return original(command, args, options)
  })
  await expect(f.acquire(f.asset('four'))).rejects.toThrow('preserved')
  expect(replaced).toBe(true)
  const root = join(f.directory, 'agent-client'),
    retired = (await readdir(root)).find((entry) => entry.startsWith('retired.'))!
  expect(await readFile(join(root, retired, 'hvir-agent'), 'utf8')).toBe('foreign')
})
