import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import {
  RemoteClientCache,
  type CachedRemoteClient,
} from '../src/main/agent/remote-client-cache'

// Retain the callback, not just the commands visible when Vitest times it out.
class CacheCase {
  private readonly pending = new Set<Promise<void>>()
  readonly cleanups: (() => Promise<void>)[] = []
  private disposal?: Promise<void>

  retain<T>(work: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(work)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
    return result
  }

  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      while (this.pending.size) await Promise.all([...this.pending])
      const failures: unknown[] = []
      for (const cleanup of this.cleanups.splice(0).reverse()) {
        try {
          await cleanup()
        } catch (reason) {
          failures.push(reason)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Cache fixture cleanup failed')
    })())
  }
}
const cases: CacheCase[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const owner of cases.splice(0).reverse()) {
    try {
      await owner.dispose()
    } catch (reason) {
      failures.push(reason)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Cache case cleanup failed')
}, 20_000)
function cacheTest(
  name: string,
  work: (owner: CacheCase) => Promise<void>,
  timeout?: number,
) {
  it(
    name,
    () => {
      const owner = new CacheCase()
      cases.push(owner)
      return owner.retain(() => work(owner))
    },
    timeout,
  )
}
function fixture(owner: CacheCase, parent = tmpdir()) {
  return owner.retain(async () => {
    const host = new LocalHost(),
      cache = new RemoteClientCache(),
      instance = randomUUID()
    let directory = ''
    // Registered before startup: chmod failure and late mkdtemp completion are owned too.
    owner.cleanups.push(
      async () => {
        if (directory) await rm(directory, { recursive: true, force: true })
      },
      () => host.dispose(),
    )
    directory = await mkdtemp(join(parent, 'hvir-cache-'))
    await chmod(directory, 0o700)
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
    const acquire = (
      value = asset(),
      base = localPath(directory),
      generation = 'host-object:1',
      clientInstance: string = instance,
    ): Promise<CachedRemoteClient> =>
      owner.retain(async () => {
        const client = await cache.acquire(
          host,
          base,
          value,
          clientInstance,
          generation,
          new AbortController().signal,
        )
        return {
          ...client,
          recordSocket: (signal) => owner.retain(() => client.recordSocket(signal)),
          release: () => owner.retain(() => client.release()),
        }
      })
    return { directory, host, asset, acquire }
  })
}
cacheTest('publishes verified private files, reuses one upload, and bounds unleased revisions', async (owner) => {
  const f = await fixture(owner),
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
}, 20_000)
cacheTest('recovers exact interrupted upload and publication objects without executing a partial client', async (owner) => {
  for (const publication of [false, true]) {
    const f = await fixture(owner),
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
    expect(await readdir(join(f.directory, 'agent-client'))).toEqual([])
    const recovered = await f.acquire()
    expect(await readFile(recovered.client.path)).toEqual(f.asset().bytes)
    await recovered.release()
  }
})
cacheTest('preserves an externally replaced failed upload and admits unrelated hashes within cache limits', async (owner) => {
  const f = await fixture(owner),
    original = f.host.fileTransfer.writeFileChunksExclusive.bind(f.host.fileTransfer)
  let upload = ''
  const spy = vi
    .spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
    .mockImplementationOnce((...args) => original(...args))
    .mockImplementationOnce(async (path, chunks, options) => {
      upload = path.path
      try {
        await original(
          path,
          (async function* () {
            for await (const chunk of chunks) {
              yield chunk.subarray(0, 8)
              throw new Error('interrupted')
            }
          })(),
          options,
        )
      } catch (reason) {
        await rename(upload, upload + '.original')
        await writeFile(upload, 'foreign')
        throw reason
      }
    })
  await expect(f.acquire()).rejects.toThrow('interrupted')
  spy.mockRestore()
  const sameHash = await f.acquire()
  await sameHash.release()
  const unrelated = await f.acquire(f.asset('two'))
  await unrelated.release()
  expect(await readFile(upload, 'utf8')).toBe('foreign')
})
cacheTest('preserves live leases, reconciles old dead sockets by actual transport probe, and uses a short socket namespace', async (owner) => {
  const f = await fixture(owner),
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
  const short = await f.acquire(f.asset(), localPath(long), 'host-object:1', 'instance')
  expect(Buffer.byteLength(short.socket.path)).toBeLessThan(104)
  expect(short.directory.path).toContain(long)
  await short.release()
}, 20_000)
cacheTest('preserves a leaf replaced after quarantine starts instead of deleting an external object', async (owner) => {
  const f = await fixture(owner)
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
}, 20_000)

cacheTest('removes only receipted dead socket leaves and preserves replacements during socket quarantine', async (owner) => {
  const { createServer } = await import('node:net')
  for (const replace of [false, true]) {
    const f = await fixture(owner, '/tmp'),
      client = await f.acquire(),
      server = createServer()
    owner.cleanups.push(
      () =>
        new Promise<void>((done) =>
          server.listening ? server.close(() => done()) : done(),
        ),
    )
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(client.socket.path, done)
    })
    await client.recordSocket(new AbortController().signal)
    // Node normally unlinks on close: retain the same dead inode to model OpenSSH's leftover leaf.
    await rename(client.socket.path, client.socket.path + '.holding')
    await new Promise<void>((done) => server.close(() => done()))
    await rename(client.socket.path + '.holding', client.socket.path)
    if (replace) {
      const original = f.host.exec.bind(f.host)
      vi.spyOn(f.host, 'exec').mockImplementation((command, args, options) => {
        if (args[1]?.includes('[ -S "$quarantine" ]')) {
          const script = args[1].replace(
            'mv "$1" "$quarantine"',
            'mv "$1" "$quarantine"\nmv "$quarantine" "$quarantine.original"\nprintf foreign > "$quarantine"',
          )
          return original(command, [args[0]!, script, ...args.slice(2)], options)
        }
        return original(command, args, options)
      })
      await expect(client.release()).rejects.toThrow('preserved')
      expect(await readFile(client.socket.path + '.retired', 'utf8')).toBe('foreign')
    } else {
      await client.release()
      const { stat } = await import('node:fs/promises')
      await expect(stat(client.socket.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }
}, 20_000)
cacheTest('bounds the separate socket namespace without deleting unrecognized leaves', async (owner) => {
  const f = await fixture(owner, '/tmp')
  for (let index = 0; index < 63; index++)
    await writeFile(join(f.directory, `foreign-${index}`), 'preserve')
  await expect(f.acquire()).rejects.toThrow('socket namespace capacity')
  expect(await readdir(f.directory)).toHaveLength(64)
  expect(await readFile(join(f.directory, 'foreign-0'), 'utf8')).toBe('preserve')
}, 20_000)
cacheTest('reconciles a stale dead receipted socket and its exact lease after interrupted application cleanup', async (owner) => {
  const { createServer } = await import('node:net'),
    { utimes, stat } = await import('node:fs/promises')
  const f = await fixture(owner, '/tmp'),
    client = await f.acquire(),
    server = createServer()
  owner.cleanups.push(
    () =>
      new Promise<void>((done) =>
        server.listening ? server.close(() => done()) : done(),
      ),
  )
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(client.socket.path, done)
  })
  await client.recordSocket(new AbortController().signal)
  await rename(client.socket.path, client.socket.path + '.holding')
  await new Promise<void>((done) => server.close(() => done()))
  await rename(client.socket.path + '.holding', client.socket.path)
  const lease = (await readdir(client.directory.path)).find((name) =>
    name.startsWith('lease.'),
  )!
  await utimes(join(client.directory.path, lease), 0, 0)
  const next = await f.acquire(f.asset('two'))
  await expect(stat(client.socket.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    (await readdir(client.directory.path)).some((name) => name.startsWith('lease.')),
  ).toBe(false)
  await next.release()
}, 20_000)

cacheTest('retries the same hash in a fresh bounded revision after disconnect prevents settled upload cleanup', async (owner) => {
  const f = await fixture(owner),
    original = f.host.fileTransfer.writeFileChunksExclusive.bind(f.host.fileTransfer)
  const execute = f.host.exec.bind(f.host)
  let disconnected = false,
    partial = ''
  vi.spyOn(f.host, 'exec').mockImplementation((...args) => {
    if (disconnected) return Promise.reject(new Error('host disconnected'))
    return execute(...args)
  })
  const upload = vi
    .spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
    .mockImplementationOnce((...args) => original(...args))
    .mockImplementationOnce((path, chunks, options) => {
      partial = path.path
      return original(
        path,
        (async function* () {
          for await (const chunk of chunks) {
            yield chunk.subarray(0, 8)
            disconnected = true
            throw new Error('host disconnected')
          }
        })(),
        options,
      )
    })
  await expect(f.acquire()).rejects.toThrow('disconnected')
  const preserved = await readFile(partial)
  upload.mockRestore()
  disconnected = false
  const recovered = await f.acquire()
  expect(recovered.directory.path).not.toBe(partial.slice(0, partial.lastIndexOf('/')))
  expect(await readFile(partial)).toEqual(preserved)
  expect(await readFile(recovered.client.path)).toEqual(f.asset().bytes)
  await recovered.release()
  expect(await readdir(join(f.directory, 'agent-client'))).toHaveLength(2)
})

cacheTest('serializes concurrent same-host cache acquisition across forward generations, reuses one upload and maintains revision bounds', async (owner) => {
  const f = await fixture(owner),
    upload = vi.spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
  const clients = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      f.acquire(f.asset(), localPath(f.directory), `forward:${index}`, 'instance'),
    ),
  )
  expect(
    upload.mock.calls.filter(([path]) => path.path.includes('/upload.')),
  ).toHaveLength(1)
  expect(new Set(clients.map((client) => client.directory.path)).size).toBe(1)
  expect(new Set(clients.map((client) => client.socket.path)).size).toBe(6)
  await Promise.all(clients.map((client) => client.release()))
  const revisions = await Promise.all(
    ['two', 'three', 'four'].map((version) => f.acquire(f.asset(version))),
  )
  expect(await readdir(join(f.directory, 'agent-client'))).toHaveLength(3)
  await Promise.all(revisions.map((client) => client.release()))
}, 20_000)

cacheTest('preserves directory-created and partial initial-marker interruptions, charges them conservatively and retries in fresh revisions', async (owner) => {
  for (const beforeMarker of [true, false]) {
    const f = await fixture(owner)
    let uncertain = ''
    const execute = f.host.exec.bind(f.host)
    const exec = vi
      .spyOn(f.host, 'exec')
      .mockImplementation(async (command, args, options) => {
        const result = await execute(command, args, options)
        if (beforeMarker && args[1]?.includes('\nmkdir "$1"\nprivate "$1"')) {
          uncertain = args[3]!
          throw new Error('disconnected before marker')
        }
        return result
      })
    const write = f.host.fileTransfer.writeFileChunksExclusive.bind(f.host.fileTransfer)
    const upload = vi.spyOn(f.host.fileTransfer, 'writeFileChunksExclusive')
    if (!beforeMarker)
      upload.mockImplementationOnce((path, chunks, options) => {
        uncertain = path.path.slice(0, path.path.lastIndexOf('/'))
        return write(
          path,
          (async function* () {
            for await (const chunk of chunks) {
              yield chunk.subarray(0, 2)
              throw new Error('disconnected during marker')
            }
          })(),
          options,
        )
      })
    await expect(f.acquire()).rejects.toThrow('disconnected')
    exec.mockRestore()
    upload.mockRestore()
    const original = await stat(uncertain)
    const priorEntries = await readdir(uncertain)
    expect(priorEntries).toEqual(beforeMarker ? [] : ['owned.json'])
    const recovered = await f.acquire()
    expect(recovered.directory.path).not.toBe(uncertain)
    expect((await stat(uncertain)).ino).toBe(original.ino)
    expect(await readdir(uncertain)).toEqual(priorEntries)
    expect(await readFile(recovered.client.path)).toEqual(f.asset().bytes)
    await recovered.release()
  }
}, 20_000)
cacheTest('bounds unreceipted recognized private revisions without assigning their ownership from a filename', async (owner) => {
  const f = await fixture(owner),
    execute = f.host.exec.bind(f.host)
  const exec = vi
    .spyOn(f.host, 'exec')
    .mockImplementation(async (command, args, options) => {
      const result = await execute(command, args, options)
      if (args[1]?.includes('\nmkdir "$1"\nprivate "$1"'))
        throw new Error('disconnected before marker')
      return result
    })
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(f.acquire()).rejects.toThrow('disconnected')
  exec.mockRestore()
  const entries = await readdir(join(f.directory, 'agent-client'))
  expect(entries).toHaveLength(3)
  await expect(f.acquire()).rejects.toThrow('capacity')
  expect(await readdir(join(f.directory, 'agent-client'))).toEqual(entries)
})

cacheTest('never recreates an unreceipted revision that disappeared after directory discovery', async (owner) => {
  const f = await fixture(owner),
    client = await f.acquire()
  await client.release()
  const execute = f.host.exec.bind(f.host)
  let removed = false
  const exec = vi
    .spyOn(f.host, 'exec')
    .mockImplementation(async (command, args, options) => {
      if (
        !removed &&
        args[3] === client.directory.path &&
        args[1]?.includes('[ -f "$1/owned.json" ]')
      ) {
        removed = true
        await rm(client.directory.path, { recursive: true })
      }
      return execute(command, args, options)
    })
  await expect(f.acquire()).rejects.toThrow('private cache')
  exec.mockRestore()
  await expect(stat(client.directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const next = await f.acquire()
  expect(next.directory.path).not.toBe(client.directory.path)
  await next.release()
})

function cacheDeferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
it('drains the full cache case including a late continuation before host and root cleanup', async () => {
  const owner = new CacheCase(),
    acquired = cacheDeferred(),
    continued = cacheDeferred(),
    late = cacheDeferred(),
    started = cacheDeferred(),
    events: string[] = []
  owner.cleanups.push(() => {
    events.push('host disposed', 'root removed')
    return Promise.resolve()
  })
  const work = owner.retain(async () => {
    started.resolve()
    await acquired.promise
    events.push('acquired')
    continued.resolve()
    await owner.retain(() => late.promise)
    events.push('late work settled')
  })
  await started.promise
  const cleanup = owner.dispose()
  expect(events).toEqual([])
  acquired.resolve()
  await continued.promise
  expect(events).toEqual(['acquired'])
  late.resolve()
  await work
  await cleanup
  expect(events).toEqual([
    'acquired',
    'late work settled',
    'host disposed',
    'root removed',
  ])
  await owner.dispose()
  expect(events).toHaveLength(4)
})
it('drains rejected-acquisition siblings and reports every reverse cleanup failure separately from the case failure', async () => {
  const owner = new CacheCase(),
    sibling = cacheDeferred(),
    started = cacheDeferred(),
    failure = new Error('acquisition failed'),
    first = new Error('host cleanup failed'),
    second = new Error('other host cleanup failed'),
    events: string[] = []
  owner.cleanups.push(() => {
    events.push('first')
    return Promise.reject(first)
  })
  owner.cleanups.push(() => {
    events.push('second')
    return Promise.reject(second)
  })
  const work = owner.retain(async () => {
    const pending = owner.retain(() => sibling.promise)
    started.resolve()
    await Promise.all([owner.retain(() => Promise.reject(failure)), pending])
  })
  await started.promise
  await expect(work).rejects.toBe(failure)
  const cleanup = owner.dispose()
  // Attach the rejection observer before releasing the remaining physical work.
  const rejected = expect(cleanup).rejects.toMatchObject({ errors: [second, first] })
  expect(events).toEqual([])
  sibling.resolve()
  await rejected
  expect(events).toEqual(['second', 'first'])
})
it('registers real fixture host cleanup before its first startup await can fail', async () => {
  const owner = new CacheCase(),
    dispose = vi.spyOn(LocalHost.prototype, 'dispose'),
    missingParent = join(tmpdir(), `absent-cache-parent-${randomUUID()}`)
  try {
    await expect(fixture(owner, missingParent)).rejects.toMatchObject({ code: 'ENOENT' })
    await owner.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  } finally {
    dispose.mockRestore()
  }
})
it('drains detached cache work admitted after disposal starts and outliving its first snapshot', async () => {
  const owner = new CacheCase(),
    admit = cacheDeferred(),
    started = cacheDeferred(),
    lateStarted = cacheDeferred(),
    late = cacheDeferred(),
    events: string[] = []
  owner.cleanups.push(() => {
    events.push('cleanup')
    return Promise.resolve()
  })
  let detached!: Promise<void>
  const first = owner.retain(async () => {
    started.resolve()
    await admit.promise
    detached = owner.retain(async () => {
      lateStarted.resolve()
      await late.promise
      events.push('detached settled')
    })
    // The first snapshot's operation does not await this new operation.
  })
  await started.promise
  const cleanup = owner.dispose()
  admit.resolve()
  try {
    await lateStarted.promise
    await first
    // Drain the first snapshot's microtasks before observing cleanup.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual([])
  } finally {
    late.resolve()
    await detached
    await cleanup
  }
  expect(events).toEqual(['detached settled', 'cleanup'])
})
it('attempts real fixture root removal after host disposal rejects and preserves the failure', async () => {
  const owner = new CacheCase(),
    f = await fixture(owner),
    original = f.host.dispose.bind(f.host),
    failure = new Error('host disposal failed after physical settlement'),
    events: string[] = []
  const dispose = vi.spyOn(f.host, 'dispose').mockImplementation(async () => {
    await original()
    expect((await stat(f.directory)).isDirectory()).toBe(true)
    events.push('host disposal attempted before root removal')
    throw failure
  })
  try {
    await expect(owner.dispose()).rejects.toMatchObject({ errors: [failure] })
    expect(events).toEqual(['host disposal attempted before root removal'])
    await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    dispose.mockRestore()
    await rm(f.directory, { recursive: true, force: true })
  }
})
