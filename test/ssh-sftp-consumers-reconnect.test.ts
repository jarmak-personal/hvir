import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { SshWatchService } from '../src/main/project-host/ssh-watch-service'
import { asHostId, hostPath } from '../src/shared'

const hostId = asHostId('ssh:consumer-reconnect')
const file = hostPath(hostId, '/project/file')
const directory = hostPath(hostId, '/project/directory')

const operations: readonly [
  string,
  (files: SshFileAccess, signal?: AbortSignal) => Promise<unknown>,
][] = [
  ['text prefix', (files, signal) => files.readTextFilePrefix(file, 100, { signal })],
  [
    'exclusive file',
    (files, signal) => files.createFileExclusive(file, { mode: 0o644, signal }),
  ],
  [
    'exclusive directory',
    (files, signal) => files.createDirectoryExclusive(directory, { mode: 0o755, signal }),
  ],
  [
    'stream read',
    async (files, signal) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of files.readFileChunks(file, { signal })) chunks.push(chunk)
      return Buffer.concat(chunks).toString()
    },
  ],
  [
    'stream write',
    (files, signal) =>
      files.writeFileChunksExclusive(file, chunks(), { mode: 0o644, signal }),
  ],
  [
    'metadata',
    (files, signal) =>
      files.setProjectFileMetadata(file, { mode: 0o644, mtimeSeconds: 1, signal }),
  ],
  [
    'rename',
    (files, signal) =>
      files.renameProjectFileNoReplace(file, hostPath(hostId, '/project/renamed'), {
        signal,
      }),
  ],
]

describe('direct SFTP consumers across reconnect', () => {
  it.each(operations)('retries initial acquisition for %s', async (name, run) => {
    const fixture = reconnectFixture()
    try {
      const operation = run(fixture.files)
      fixture.files.advanceGeneration()
      fixture.opening.resolve(fixture.stale.wrapper)
      const value = await operation

      if (name === 'text prefix') expect(value).toMatchObject({ content: 'abc' })
      else if (name === 'stream read') expect(value).toBe('abc')
      else expect(value).toBeUndefined()
      expect(fixture.openSftp).toHaveBeenCalledTimes(2)
      expect(fixture.stale.end).toHaveBeenCalledOnce()
      expect(fixture.stale.open).not.toHaveBeenCalled()
      expect(fixture.stale.createReadStream).not.toHaveBeenCalled()
      expect(fixture.stale.mkdir).not.toHaveBeenCalled()
      expect(fixture.stale.rename).not.toHaveBeenCalled()
    } finally {
      fixture.files.dispose()
    }
  })

  it.each(operations)(
    'cancels initial acquisition for %s without retry or submission',
    async (_name, run) => {
      const fixture = reconnectFixture()
      const controller = new AbortController()
      try {
        const operation = run(fixture.files, controller.signal)
        fixture.files.advanceGeneration()
        controller.abort()
        fixture.opening.resolve(fixture.stale.wrapper)

        await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
        expect(fixture.openSftp).toHaveBeenCalledOnce()
        expect(fixture.stale.open).not.toHaveBeenCalled()
        expect(fixture.stale.createReadStream).not.toHaveBeenCalled()
        expect(fixture.stale.mkdir).not.toHaveBeenCalled()
        expect(fixture.stale.setstat).not.toHaveBeenCalled()
        expect(fixture.stale.rename).not.toHaveBeenCalled()
      } finally {
        fixture.files.dispose()
      }
    },
  )

  it('keeps an opened read handle and its cleanup on the original session', async () => {
    const original = session()
    const fresh = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockResolvedValueOnce(original.wrapper)
      .mockResolvedValue(fresh.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    const reader = files.readFileChunks(file)[Symbol.asyncIterator]()
    try {
      await expect(reader.next()).resolves.toMatchObject({
        value: Buffer.from('abc'),
        done: false,
      })
      files.advanceGeneration()
      await files.realpath(file)

      await expect(reader.next()).rejects.toThrow('original SFTP session closed')
      expect(original.close).toHaveBeenCalledOnce()
      expect(fresh.read).not.toHaveBeenCalled()
      expect(fresh.close).not.toHaveBeenCalled()
      expect(fresh.open).not.toHaveBeenCalled()
    } finally {
      await reader.return?.()
      files.dispose()
    }
  })

  it('keeps an opened write handle and its cleanup on the original session', async () => {
    const original = session()
    const fresh = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockResolvedValueOnce(original.wrapper)
      .mockResolvedValue(fresh.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    async function* interruptedChunks() {
      yield Buffer.from('first')
      files.advanceGeneration()
      await files.realpath(file)
      yield Buffer.from('second')
    }
    try {
      await expect(
        files.writeFileChunksExclusive(file, interruptedChunks(), { mode: 0o644 }),
      ).rejects.toThrow('original SFTP session closed')
      expect(original.close).toHaveBeenCalledOnce()
      expect(fresh.write).not.toHaveBeenCalled()
      expect(fresh.fsetstat).not.toHaveBeenCalled()
      expect(fresh.close).not.toHaveBeenCalled()
      expect(fresh.open).not.toHaveBeenCalled()
      // Path-based rollback may acquire a fresh session; opaque handles may not.
      expect(fresh.unlink).toHaveBeenCalledOnce()
    } finally {
      files.dispose()
    }
  })

  it('keeps an exclusive-create handle on its session after the create callback', async () => {
    const original = session()
    const fresh = session()
    const failure = new Error('original session lost during creation')
    original.fsetstat.mockImplementation(() => {
      throw failure
    })
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockResolvedValueOnce(original.wrapper)
      .mockResolvedValue(fresh.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      await expect(
        files.createFileExclusive(file, {
          mode: 0o644,
          onCreated: () => files.advanceGeneration(),
        }),
      ).rejects.toBe(failure)
      expect(original.close).toHaveBeenCalledOnce()
      expect(fresh.fsetstat).not.toHaveBeenCalled()
      expect(fresh.close).not.toHaveBeenCalled()
      expect(fresh.open).not.toHaveBeenCalled()
    } finally {
      files.dispose()
    }
  })

  it('recovers a watcher snapshot whose initial SFTP acquisition was replaced', async () => {
    vi.useFakeTimers()
    const fixture = reconnectFixture()
    const ready = deferred<void>()
    const onError = vi.fn()
    const onEvent = vi.fn(() => ready.resolve())
    const stop = watches(fixture.files).watch(directory, onEvent, {
      recursive: false,
      onError,
    })
    try {
      fixture.files.advanceGeneration()
      fixture.opening.resolve(fixture.stale.wrapper)
      await ready.promise

      expect(onError).not.toHaveBeenCalled()
      expect(onEvent).toHaveBeenCalledWith({
        type: 'change',
        path: directory,
        synthetic: 'refresh',
      })
      expect(fixture.openSftp).toHaveBeenCalledTimes(2)
      expect(fixture.fresh.readdir).toHaveBeenCalledOnce()
    } finally {
      await stop()
      fixture.files.dispose()
      vi.useRealTimers()
    }
  })

  it('does not revive a stopped watcher when its pending acquisition becomes stale', async () => {
    vi.useFakeTimers()
    const fixture = reconnectFixture()
    const onError = vi.fn()
    const onEvent = vi.fn()
    const stop = watches(fixture.files).watch(directory, onEvent, {
      recursive: false,
      onError,
    })
    try {
      fixture.files.advanceGeneration()
      await stop()
      fixture.opening.resolve(fixture.stale.wrapper)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(onError).not.toHaveBeenCalled()
      expect(onEvent).not.toHaveBeenCalled()
      expect(fixture.openSftp).toHaveBeenCalledOnce()
      expect(fixture.stale.lstat).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await stop()
      fixture.files.dispose()
      vi.useRealTimers()
    }
  })

  it('cancels a stopped watcher while the recursive scan acquires a session', async () => {
    vi.useFakeTimers()
    const fixture = reconnectFixture()
    const scanStarted = deferred<void>()
    fixture.openSftp
      .mockReset()
      .mockResolvedValueOnce(fixture.fresh.wrapper)
      .mockImplementationOnce(() => {
        scanStarted.resolve()
        return fixture.opening.promise
      })
      .mockResolvedValue(fixture.fresh.wrapper)
    const onError = vi.fn()
    const onEvent = vi.fn(() => fixture.files.advanceGeneration())
    const stop = watches(fixture.files).watch(directory, onEvent, { onError })
    try {
      await scanStarted.promise
      await stop()
      fixture.files.advanceGeneration()
      fixture.opening.resolve(fixture.stale.wrapper)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(onError).not.toHaveBeenCalled()
      expect(onEvent).toHaveBeenCalledOnce()
      expect(fixture.openSftp).toHaveBeenCalledTimes(2)
      expect(fixture.stale.readdir).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await stop()
      fixture.files.dispose()
      vi.useRealTimers()
    }
  })
})

function watches(files: SshFileAccess) {
  return new SshWatchService(
    {
      hostId,
      connectionState: () => 'connected',
      watchTier: () => 'polling',
      setWatchTier: () => undefined,
      onConnectionState: (onState) => {
        onState('connected')
        return () => undefined
      },
      execStream: () => {
        throw new Error('polling needs no exec channel')
      },
    },
    files,
    {},
  )
}

function reconnectFixture() {
  const opening = deferred<SFTPWrapper>()
  const stale = session()
  const fresh = session()
  const openSftp = vi
    .fn<() => Promise<SFTPWrapper>>()
    .mockReturnValueOnce(opening.promise)
    .mockResolvedValue(fresh.wrapper)
  const files = new SshFileAccess({ hostId, openSftp }, {})
  return { files, opening, openSftp, stale, fresh }
}

function session() {
  const handle = Buffer.from('session-owned-handle')
  let closed = false
  const assertOpen = () => {
    if (closed) throw new Error('original SFTP session closed')
  }
  type Done = (error?: Error) => void
  type OpenDone = (error: undefined, handle: Buffer) => void
  const value = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      closed = true
      value.emit('close')
    }),
    realpath: vi.fn((path: string, done: (error: undefined, path: string) => void) =>
      done(undefined, path),
    ),
    lstat: vi.fn((path: string, done: (error: undefined, attrs: unknown) => void) =>
      done(undefined, {
        mode: path === directory.path ? 0o040755 : 0o100644,
        size: 0,
        mtime: 1,
      }),
    ),
    readdir: vi.fn(
      (_path: string, done: (error: undefined, entries: unknown[]) => void) =>
        done(undefined, []),
    ),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('abc')])),
    open: vi.fn(
      (
        _path: string,
        _flags: string,
        attrsOrDone: { mode: number } | OpenDone,
        done?: OpenDone,
      ) => {
        assertOpen()
        if (typeof attrsOrDone === 'function')
          attrsOrDone(undefined, handle)
        else done!(undefined, handle)
      },
    ),
    read: vi.fn(
      (
        _handle: Buffer,
        buffer: Buffer,
        offset: number,
        _length: number,
        position: number,
        done: (error: undefined, bytesRead: number, data: Buffer) => void,
      ) => {
        assertOpen()
        const length = position === 0 ? buffer.write('abc', offset) : 0
        done(undefined, length, buffer.subarray(offset, offset + length))
      },
    ),
    write: vi.fn(
      (
        _handle: Buffer,
        _value: Buffer,
        _offset: number,
        _length: number,
        _position: number,
        done: Done,
      ) => {
        assertOpen()
        done()
      },
    ),
    fsetstat: vi.fn((_handle: Buffer, _attrs: unknown, done: Done) => {
      assertOpen()
      done()
    }),
    close: vi.fn((_handle: Buffer, done: Done) => {
      assertOpen()
      done()
    }),
    mkdir: vi.fn((_path: string, _attrs: unknown, done: Done) => done()),
    setstat: vi.fn((_path: string, _attrs: unknown, done: Done) => done()),
    rename: vi.fn((_source: string, _destination: string, done: Done) => done()),
    unlink: vi.fn((_path: string, done: Done) => done()),
  })
  return { ...value, wrapper: value as unknown as SFTPWrapper }
}

async function* chunks() {
  await Promise.resolve()
  yield Buffer.from('abc')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
