import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'

import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { asHostId, hostPath } from '../src/shared'

describe('SshFileAccess', () => {
  it('invalidates cached descendants and parent listings', () => {
    const files = fileAccess()
    const cache = new Map<string, unknown>([
      ['d:/project', []],
      ['d:/project/new-dir', []],
      ['f:/project/new-dir/file.txt', Buffer.from('old')],
      ['d:/unrelated', []],
    ])
    ;(files as unknown as { cache: Map<string, unknown> }).cache = cache

    files.invalidate('/project/new-dir/file.txt')

    expect([...cache.keys()]).toEqual(['d:/unrelated'])
  })

  it('invalidates every cached descendant when the watched root is slash', () => {
    const files = fileAccess()
    const cache = new Map<string, unknown>([
      ['d:/', []],
      ['d:/home', []],
      ['f:/home/picard/file.txt', Buffer.from('old')],
    ])
    ;(files as unknown as { cache: Map<string, unknown> }).cache = cache

    files.invalidate('/')

    expect(cache.size).toBe(0)
  })

  it('rejects and closes an SFTP session from a stale connection generation', async () => {
    let resolveSession!: (session: SFTPWrapper) => void
    const opening = new Promise<SFTPWrapper>((resolve) => {
      resolveSession = resolve
    })
    const files = fileAccess(() => opening)
    const session = Object.assign(new EventEmitter(), { end: vi.fn() })

    const pending = files.getSftp()
    files.advanceGeneration()
    resolveSession(session as unknown as SFTPWrapper)

    await expect(pending).rejects.toThrow('stale connection generation')
    expect(session.end).toHaveBeenCalledOnce()
    files.dispose()
    expect(session.end).toHaveBeenCalledOnce()
  })

  it('retains optimistic-save content authority across reconnect generations', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/file.txt')
    const attrs = { mode: 0o100640, mtime: 100, size: 5, atime: 100 }
    const firstSession = {
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from('first')),
      ),
      once: vi.fn(),
      end: vi.fn(),
    }
    const secondSession = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, attrs),
      ),
      writeFile: vi.fn(
        (
          _path: string,
          _data: Buffer,
          _options: unknown,
          callback: (error?: Error) => void,
        ) => callback(),
      ),
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from('other')),
      ),
      ext_openssh_rename: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
      once: vi.fn(),
      end: vi.fn(),
    }
    const openSftp = vi
      .fn<() => Promise<SFTPWrapper>>()
      .mockResolvedValueOnce(firstSession as unknown as SFTPWrapper)
      .mockResolvedValueOnce(secondSession as unknown as SFTPWrapper)
    const files = new SshFileAccess(
      { hostId, openSftp },
      { fingerprintObservationWindowMs: 5_000 },
    )

    await files.readFile(path, { pollingInterest: true })
    files.advanceGeneration()

    await expect(
      files.writeFile(path, 'mine!', { expectedMtimeMs: 100_000 }),
    ).rejects.toThrow('changed on the remote host')

    expect(openSftp).toHaveBeenCalledTimes(2)
    expect(firstSession.end).toHaveBeenCalledOnce()
    expect(secondSession.ext_openssh_rename).not.toHaveBeenCalled()
    expect(secondSession.rename).not.toHaveBeenCalled()
    expect(secondSession.unlink).toHaveBeenCalledOnce()
    files.dispose()
  })

  it('cancels an in-flight SFTP write and removes its unpublished temporary', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/image.png')
    const stream = new Writable({
      write: (_chunk, _encoding, _callback) => undefined,
    })
    const destroy = vi.spyOn(stream, 'destroy')
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100600, mtime: 100, size: 0, atime: 100 }),
      ),
      createWriteStream: vi.fn(() => stream),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      {
        hostId,
        openSftp: () => Promise.resolve(session as unknown as SFTPWrapper),
      },
      {},
    )
    const controller = new AbortController()
    const writing = files.writeFile(path, Buffer.from([1, 2, 3]), {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(session.createWriteStream).toHaveBeenCalledOnce())

    controller.abort()

    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    expect(destroy).toHaveBeenCalledOnce()
    expect(session.unlink).toHaveBeenCalledOnce()
    files.dispose()
  })

  it('removes only the observed version of a remote file', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/keybindings.json')
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100600, mtime: 100, size: 5, atime: 100 }),
      ),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      {
        hostId,
        openSftp: () => Promise.resolve(session as unknown as SFTPWrapper),
      },
      {},
    )

    await files.removeFile(path, { expectedMtimeMs: 100_000 })

    expect(session.unlink).toHaveBeenCalledWith(path.path, expect.any(Function))
    files.dispose()
  })

  it('refuses to remove a stale remote file', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/keybindings.json')
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100600, mtime: 101, size: 5, atime: 100 }),
      ),
      unlink: vi.fn(),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      {
        hostId,
        openSftp: () => Promise.resolve(session as unknown as SFTPWrapper),
      },
      {},
    )

    await expect(files.removeFile(path, { expectedMtimeMs: 100_000 })).rejects.toThrow(
      'changed on the remote host',
    )
    expect(session.unlink).not.toHaveBeenCalled()
    files.dispose()
  })

  it('allows idempotent removal and clears optimistic-save state', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/already-removed.png')
    const missing = Object.assign(new Error('missing'), { code: 2 })
    const session = {
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) =>
        callback(missing),
      ),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      {
        hostId,
        openSftp: () => Promise.resolve(session as unknown as SFTPWrapper),
      },
      {},
    )
    const digests = (files as unknown as { readDigests: Map<string, string> }).readDigests
    digests.set(path.path, 'stale')

    await expect(files.removeFile(path, { ignoreMissing: true })).resolves.toBeUndefined()
    expect(digests.has(path.path)).toBe(false)
    files.dispose()
  })
})

function fileAccess(
  openSftp: () => Promise<SFTPWrapper> = () =>
    Promise.reject(new Error('SFTP is not configured for this test')),
): SshFileAccess {
  return new SshFileAccess({ hostId: asHostId('example'), openSftp }, {})
}
