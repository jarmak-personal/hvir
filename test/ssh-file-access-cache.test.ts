import { EventEmitter } from 'node:events'

import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { asHostId, hostPath, type DirEntry } from '../src/shared'

const hostId = asHostId('ssh:cache')
const path = (name: string) => hostPath(hostId, name)
const owners: SshFileAccess[] = []

afterEach(() => {
  for (const files of owners.splice(0)) files.dispose()
  vi.useRealTimers()
})

describe('SSH file cache retention', () => {
  it('bounds distinct file payloads and preserves hits and returned-buffer isolation', async () => {
    vi.useFakeTimers()
    const { files, session } = fixture(1024 * 1024)
    for (let i = 0; i < 100; i++) await files.readFile(path(`/file-${i}`))

    const retained = retention(files)
    expect(retained.cache.size).toBeGreaterThan(0)
    expect(retained.cache.size).toBeLessThan(100)
    expect(retained.cacheBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(
      [...retained.cache.values()].reduce(
        (sum, entry) => sum + (Buffer.isBuffer(entry.value) ? entry.value.byteLength : 0),
        0,
      ),
    ).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(
      [...retained.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    ).toBe(retained.cacheBytes)
    const first = await files.readFile(path('/file-99'))
    first.fill(0)
    expect((await files.readFile(path('/file-99')))[0]).toBe(7)
    expect(session.readFile).toHaveBeenCalledTimes(100)
    await files.readFile(path('/file-0'))
    expect(session.readFile).toHaveBeenCalledTimes(101)
  })

  it('bounds combined file and directory entries even when payloads are empty', async () => {
    vi.useFakeTimers()
    const { files } = fixture(0)
    for (let i = 0; i < 200; i++) {
      await files.readFile(path(`/file-${i}`))
      await files.readdir(path(`/dir-${i}`))
    }
    expect(retention(files).cache.size).toBe(256)
    expect(retention(files).cacheBytes).toBeGreaterThan(0)
  })

  it('charges directory listing names against the shared byte budget', async () => {
    vi.useFakeTimers()
    const { files, session } = fixture(0)
    const entries = Array.from({ length: 1024 }, (_, i) => ({
      filename: `${i}-${'x'.repeat(1024)}`,
      attrs: { mode: 0o100644 },
    }))
    session.readdir.mockImplementation((_name, done) => done(undefined, entries))
    for (let i = 0; i < 20; i++) await files.readdir(path(`/dir-${i}`))
    expect(retention(files).cache.size).toBeGreaterThan(0)
    expect(retention(files).cache.size).toBeLessThan(20)
    expect(retention(files).cacheBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    const listing = await files.readdir(path('/dir-19'))
    listing.pop()
    expect(await files.readdir(path('/dir-19'))).toHaveLength(1024)
    expect(session.readdir).toHaveBeenCalledTimes(20)
  })

  it('reclaims expired entries while idle without extending expiry on a hit', async () => {
    vi.useFakeTimers()
    const { files, session } = fixture()
    await files.readFile(path('/first'))
    await vi.advanceTimersByTimeAsync(1000)
    await files.readdir(path('/second'))
    await files.readFile(path('/first'))
    expect(session.readFile).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect([...retention(files).cache.keys()]).toEqual(['d:/second'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(retention(files).cache.size).toBe(0)
    expect(retention(files).cacheBytes).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prunes expired paths on access when the expiry callback has not run', async () => {
    vi.useFakeTimers()
    const { files } = fixture()
    await files.readFile(path('/old'))
    vi.setSystemTime(Date.now() + 60_000)
    await files.readFile(path('/new'))
    expect([...retention(files).cache.keys()]).toEqual(['f:/new'])
  })

  it('delivers oversized files and listings without retaining or evicting for them', async () => {
    vi.useFakeTimers()
    const { files, session } = fixture()
    await files.readFile(path('/small'))
    session.readFile.mockImplementation((_name, done) =>
      done(undefined, Buffer.alloc(16 * 1024 * 1024)),
    )
    const entries = [{ filename: 'x'.repeat(8 * 1024 * 1024), attrs: { mode: 0o100644 } }]
    session.readdir.mockImplementation((_name, done) => done(undefined, entries))
    expect(await files.readFile(path('/large'))).toHaveLength(16 * 1024 * 1024)
    expect(await files.readdir(path('/large-dir'))).toHaveLength(1)
    expect([...retention(files).cache.keys()]).toEqual(['f:/small'])
    await files.readFile(path('/large'))
    await files.readdir(path('/large-dir'))
    expect(session.readFile).toHaveBeenCalledTimes(3)
    expect(session.readdir).toHaveBeenCalledTimes(2)
  })

  it('invalidates descendants and ancestor listings while preserving unrelated hits', async () => {
    vi.useFakeTimers()
    const { files, session } = fixture()
    await files.readdir(path('/'))
    await files.readdir(path('/project'))
    await files.readdir(path('/project/child'))
    await files.readFile(path('/project/child/file'))
    await files.readFile(path('/project/children/file'))
    files.invalidate('/project/child/')
    expect([...retention(files).cache.keys()]).toEqual(['f:/project/children/file'])
    expect(retention(files).cacheBytes).toBeGreaterThan(0)
    await files.readFile(path('/project/children/file'))
    expect(session.readFile).toHaveBeenCalledTimes(2)
    await files.readFile(path('/project/child/file'))
    expect(session.readFile).toHaveBeenCalledTimes(3)
    files.invalidate('/')
    expect(retention(files).cache.size).toBe(0)
    expect(retention(files).cacheBytes).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await files.readFile(path('/refilled'))
    expect(retention(files).cacheBytes).toBeGreaterThan(0)
  })

  it.each(['disconnect', 'dispose'] as const)(
    'releases retained data and rejects late file and directory completion after %s',
    async (action) => {
      vi.useFakeTimers()
      const { files, session } = fixture()
      await files.readFile(path('/cached'))
      await files.readdir(path('/cached-dir'))
      const fileSubmitted = submittedOperation()
      const dirSubmitted = submittedOperation()
      let finishFile!: (error: undefined, value: Buffer) => void
      let finishDir!: (error: undefined, value: Listing) => void
      session.readFile.mockImplementation((_name, done) => {
        finishFile = done
        fileSubmitted.resolve()
      })
      session.readdir.mockImplementation((_name, done) => {
        finishDir = done
        dirSubmitted.resolve()
      })
      const reading = files.readFile(path('/late'), { pollingInterest: true })
      const listing = files.readdir(path('/late-dir'))
      await Promise.all([fileSubmitted.promise, dirSubmitted.promise])
      if (action === 'dispose') files.dispose()
      else files.advanceGeneration()
      expect(retention(files).cache.size).toBe(0)
      expect(retention(files).cacheBytes).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      finishFile(undefined, Buffer.from('late'))
      finishDir(undefined, [])
      await expect(reading).rejects.toThrow('stale connection generation')
      await expect(listing).rejects.toThrow('stale connection generation')
      expect(retention(files).cache.size).toBe(0)
      expect(retention(files).cacheBytes).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['expiry', 'eviction'] as const)(
    'keeps optimistic-save content authority after payload %s',
    async (action) => {
      vi.useFakeTimers()
      const { files, session } = fixture()
      await files.readFile(path('/file'))
      await files.readFile(path('/file'), { pollingInterest: true })
      expect(session.readFile).toHaveBeenCalledOnce()
      if (action === 'expiry') await vi.advanceTimersByTimeAsync(2000)
      else for (let i = 0; i < 256; i++) await files.readFile(path(`/other-${i}`))
      expect(retention(files).cache.has('f:/file')).toBe(false)
      session.readFile.mockImplementation((_name, done) =>
        done(undefined, Buffer.from('changed')),
      )
      await expect(files.writeFile(path('/file'), 'replacement')).rejects.toThrow(
        'changed on the remote host',
      )
      expect(session.ext_openssh_rename).not.toHaveBeenCalled()
      expect(session.unlink).toHaveBeenCalledOnce()
    },
  )
})

type Listing = { filename: string; attrs: { mode: number } }[]

function fixture(fileBytes = 8) {
  const session = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    readFile: vi.fn((_name: string, done: (error: undefined, value: Buffer) => void) =>
      done(undefined, Buffer.alloc(fileBytes, 7)),
    ),
    readdir: vi.fn((_name: string, done: (error: undefined, value: Listing) => void) =>
      done(undefined, []),
    ),
    lstat: vi.fn((_name: string, done: (error: undefined, value: unknown) => void) =>
      done(undefined, { mode: 0o100644, mtime: 100, size: fileBytes }),
    ),
    writeFile: vi.fn((_name: string, _value: Buffer, _opts: unknown, done: () => void) =>
      done(),
    ),
    ext_openssh_rename: vi.fn(),
    unlink: vi.fn((_name: string, done: () => void) => done()),
  })
  const files = new SshFileAccess(
    {
      hostId,
      openSftp: () => Promise.resolve(session as unknown as SFTPWrapper),
    },
    {},
  )
  owners.push(files)
  return { files, session }
}

// Retention is a resource contract, so inspect storage without widening the production API.
function retention(files: SshFileAccess) {
  return files as unknown as {
    cache: Map<string, { bytes: number; value: Buffer | DirEntry[] }>
    cacheBytes: number
  }
}

function submittedOperation() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
