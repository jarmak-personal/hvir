import { EventEmitter } from 'node:events'

import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { asHostId, hostPath } from '../src/shared'

const hostId = asHostId('ssh:reconnect')
const path = hostPath(hostId, '/project')

describe('SshFileAccess reconnect acquisition', () => {
  it('preserves the original failure when acquisition itself starts the replacement connection', async () => {
    const failure = new Error('replacement connection refused')
    const openSftp = vi.fn<() => Promise<SFTPWrapper>>(() => {
      files.advanceGeneration()
      return Promise.reject(failure)
    })
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      await expect(files.stat(path)).rejects.toBe(failure)
      expect(openSftp).toHaveBeenCalledOnce()
    } finally {
      files.dispose()
    }
  })

  it('retries concurrent metadata operations on one fresh session and closes the stale one', async () => {
    const opening = deferred<SFTPWrapper>()
    const stale = session()
    const fresh = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockReturnValueOnce(opening.promise)
      .mockResolvedValue(fresh.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      const operations = Promise.all([
        files.stat(path),
        files.realpath(path),
        files.readdir(path),
      ])
      files.advanceGeneration()
      opening.resolve(stale.wrapper)

      await expect(operations).resolves.toEqual([
        { type: 'dir', size: 0, mtimeMs: 100_000, mode: 0o040755 },
        path,
        [{ name: 'child', type: 'dir' }],
      ])
      expect(openSftp).toHaveBeenCalledTimes(2)
      expect(stale.end).toHaveBeenCalledOnce()
      expect(stale.lstat).not.toHaveBeenCalled()
      expect(stale.realpath).not.toHaveBeenCalled()
      expect(stale.readdir).not.toHaveBeenCalled()
      await expect(files.stat(path)).resolves.toMatchObject({ type: 'dir' })
      expect(openSftp).toHaveBeenCalledTimes(2)
      expect(fresh.end).not.toHaveBeenCalled()
    } finally {
      files.dispose()
    }
  })

  it('retries an old transport acquisition failure after the generation advances', async () => {
    const opening = deferred<SFTPWrapper>()
    const fresh = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockReturnValueOnce(opening.promise)
      .mockResolvedValueOnce(fresh.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      const operation = files.realpath(path)
      files.advanceGeneration()
      opening.reject(new Error('old transport closed'))

      await expect(operation).resolves.toEqual(path)
      expect(openSftp).toHaveBeenCalledTimes(2)
    } finally {
      files.dispose()
    }
  })

  it('reports a second generation loss without opening a third session', async () => {
    const first = deferred<SFTPWrapper>()
    const second = deferred<SFTPWrapper>()
    const retryStarted = deferred<void>()
    const stale = session()
    const retry = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(() => {
        retryStarted.resolve()
        return second.promise
      })
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      const operation = files.stat(path)
      files.advanceGeneration()
      first.resolve(stale.wrapper)
      await retryStarted.promise
      files.advanceGeneration()
      second.resolve(retry.wrapper)

      await expect(operation).rejects.toThrow('stale connection generation')
      expect(openSftp).toHaveBeenCalledTimes(2)
      expect(stale.end).toHaveBeenCalledOnce()
      expect(retry.end).toHaveBeenCalledOnce()
      expect(retry.lstat).not.toHaveBeenCalled()
    } finally {
      files.dispose()
    }
  })

  it.each([false, true])(
    'preserves acquisition errors with retry=%s',
    async (reconnect) => {
      const opening = deferred<SFTPWrapper>()
      const failure = new Error('SFTP unavailable')
      const openSftp = vi
        .fn<() => Promise<SFTPWrapper>>()
        .mockReturnValueOnce(opening.promise)
        .mockRejectedValue(failure)
      const files = new SshFileAccess({ hostId, openSftp }, {})
      try {
        const operation = files.stat(path)
        if (reconnect) files.advanceGeneration()
        opening.reject(failure)

        await expect(operation).rejects.toBe(failure)
        expect(openSftp).toHaveBeenCalledTimes(reconnect ? 2 : 1)
      } finally {
        files.dispose()
      }
    },
  )

  it.each(['abort', 'dispose'] as const)(
    'does not retry after %s while opening',
    async (action) => {
      const opening = deferred<SFTPWrapper>()
      const stale = session()
      const openSftp = vi.fn(() => opening.promise)
      const files = new SshFileAccess({ hostId, openSftp }, {})
      const controller = new AbortController()
      try {
        const operation = files.readFile(path, { signal: controller.signal })
        files.advanceGeneration()
        if (action === 'abort') controller.abort()
        else files.dispose()
        opening.resolve(stale.wrapper)

        await expect(operation).rejects.toThrow(
          action === 'abort' ? 'aborted' : 'stale connection generation',
        )
        expect(openSftp).toHaveBeenCalledOnce()
        expect(stale.end).toHaveBeenCalledOnce()
      } finally {
        files.dispose()
      }
    },
  )

  it('cancels while awaiting the retry without submitting the read', async () => {
    const opening = deferred<SFTPWrapper>()
    const retryStarted = deferred<void>()
    const retryOpening = deferred<SFTPWrapper>()
    const stale = session()
    const fresh = session()
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockReturnValueOnce(opening.promise)
      .mockImplementationOnce(() => {
        retryStarted.resolve()
        return retryOpening.promise
      })
    const files = new SshFileAccess({ hostId, openSftp }, {})
    const controller = new AbortController()
    try {
      const operation = files.readFile(path, { signal: controller.signal })
      files.advanceGeneration()
      opening.resolve(stale.wrapper)
      await retryStarted.promise
      controller.abort()
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      retryOpening.resolve(fresh.wrapper)
      await files.getSftp()

      expect(fresh.readFile).not.toHaveBeenCalled()
      expect(openSftp).toHaveBeenCalledTimes(2)
    } finally {
      files.dispose()
    }
  })

  it('rejects disposal before submission even when a session was already available', async () => {
    const active = session()
    const openSftp = vi.fn<() => Promise<SFTPWrapper>>().mockResolvedValue(active.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      await files.getSftp()
      const operation = files.stat(path)
      files.dispose()

      await expect(operation).rejects.toThrow('disposed')
      expect(active.lstat).not.toHaveBeenCalled()
      expect(openSftp).toHaveBeenCalledOnce()
      expect(active.end).toHaveBeenCalledOnce()
    } finally {
      files.dispose()
    }
  })

  it('does not replay a submitted mutation that fails during reconnect', async () => {
    const active = session()
    const failed = deferred<void>()
    const submitted = deferred<void>()
    const failure = new Error('transport closed after unlink submission')
    active.unlink.mockImplementation((_path, done) => {
      submitted.resolve()
      void failed.promise.then(() => done(failure))
    })
    const openSftp = vi.fn<() => Promise<SFTPWrapper>>().mockResolvedValue(active.wrapper)
    const files = new SshFileAccess({ hostId, openSftp }, {})
    try {
      const operation = files.removeFile(path)
      await submitted.promise
      files.advanceGeneration()
      failed.resolve()

      await expect(operation).rejects.toBe(failure)
      expect(active.unlink).toHaveBeenCalledOnce()
      expect(openSftp).toHaveBeenCalledOnce()
    } finally {
      files.dispose()
    }
  })
})

function session() {
  const attrs = { mode: 0o040755, size: 0, mtime: 100 }
  const value = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      value.emit('close')
    }),
    lstat: vi.fn(
      (_path: string, done: (error: undefined, value: typeof attrs) => void) => {
        done(undefined, attrs)
      },
    ),
    realpath: vi.fn((_path: string, done: (error: undefined, value: string) => void) => {
      done(undefined, path.path)
    }),
    readdir: vi.fn((_path: string, done: (error: undefined, value: unknown) => void) => {
      done(undefined, [{ filename: 'child', attrs }])
    }),
    readFile: vi.fn(),
    unlink: vi.fn((_path: string, done: (error?: Error) => void) => {
      done()
    }),
  })
  return { ...value, wrapper: value as unknown as SFTPWrapper }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
