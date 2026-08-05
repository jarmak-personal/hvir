import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'

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

  it('awaits an exclusive-open callback after cancellation, then owns cleanup', async () => {
    const hostId = asHostId('ssh:transfer-open')
    const path = hostPath(hostId, '/project/staging')
    let finishOpen!: (error: Error | undefined, handle: Buffer) => void
    const session = {
      open: vi.fn(
        (_path: string, _flags: string, _attrs: unknown, callback: typeof finishOpen) => {
          finishOpen = callback
        },
      ),
      close: vi.fn((_handle: Buffer, callback: (error?: Error) => void) => callback()),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const controller = new AbortController()
    const created = vi.fn()
    const writing = files.writeFileChunksExclusive(path, emptyChunks(), {
      mode: 0o644,
      signal: controller.signal,
      onCreated: created,
    })
    await vi.waitFor(() => expect(session.open).toHaveBeenCalledOnce())

    controller.abort()
    await expect(
      Promise.race([writing.then(() => 'settled'), Promise.resolve('open')]),
    ).resolves.toBe('open')
    finishOpen(undefined, Buffer.from('handle'))

    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    expect(created).toHaveBeenCalledOnce()
    expect(session.close).toHaveBeenCalledOnce()
    expect(session.unlink).toHaveBeenCalledOnce()
  })

  it('does not report cancellation while a submitted write callback is pending', async () => {
    const hostId = asHostId('ssh:transfer-write')
    const path = hostPath(hostId, '/project/staging')
    let finishWrite!: (error?: Error) => void
    const session = {
      open: vi.fn(
        (
          _path: string,
          _flags: string,
          _attrs: unknown,
          callback: (error: Error | undefined, handle: Buffer) => void,
        ) => callback(undefined, Buffer.from('handle')),
      ),
      write: vi.fn(
        (
          _handle: Buffer,
          _value: Buffer,
          _offset: number,
          _length: number,
          _position: number,
          callback: typeof finishWrite,
        ) => {
          finishWrite = callback
        },
      ),
      close: vi.fn((_handle: Buffer, callback: (error?: Error) => void) => callback()),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const controller = new AbortController()
    let settled = false
    const writing = files
      .writeFileChunksExclusive(path, oneChunk(), {
        mode: 0o644,
        signal: controller.signal,
      })
      .finally(() => {
        settled = true
      })
    await vi.waitFor(() => expect(session.write).toHaveBeenCalledOnce())

    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishWrite()

    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    expect(session.unlink).toHaveBeenCalledOnce()
  })

  it('truthfully completes a submitted no-replace rename after cancellation', async () => {
    const hostId = asHostId('ssh:transfer-rename')
    const source = hostPath(hostId, '/project/.hvir-import-stage')
    const destination = hostPath(hostId, '/project/published')
    let finishRename!: (error?: Error) => void
    const session = {
      rename: vi.fn(
        (_source: string, _destination: string, callback: typeof finishRename) => {
          finishRename = callback
        },
      ),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const controller = new AbortController()
    const onSubmitted = vi.fn()
    const publishing = files.renameProjectFileNoReplace(source, destination, {
      signal: controller.signal,
      onSubmitted,
    })
    await vi.waitFor(() => expect(session.rename).toHaveBeenCalledOnce())

    controller.abort()
    finishRename()

    await expect(publishing).resolves.toBeUndefined()
    expect(onSubmitted).toHaveBeenCalledOnce()
  })

  it('reconciles a submitted rename whose late transport error follows completion', async () => {
    const hostId = asHostId('ssh:transfer-rename-late-error')
    const source = hostPath(hostId, '/project/source')
    const destination = hostPath(hostId, '/project/destination')
    const missing = Object.assign(new Error('missing'), { code: 2 })
    let finishRename!: (error?: Error) => void
    const session = {
      rename: vi.fn(
        (_source: string, _destination: string, callback: typeof finishRename) => {
          finishRename = callback
        },
      ),
      lstat: vi.fn(
        (path: string, callback: (error: Error | undefined, value?: unknown) => void) => {
          if (path === source.path) callback(missing)
          else callback(undefined, { mode: 0o100644, mtime: 100, size: 5, atime: 100 })
        },
      ),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const onSubmitted = vi.fn()
    const publishing = files.renameProjectFileNoReplace(source, destination, {
      onSubmitted,
    })
    await vi.waitFor(() => expect(session.rename).toHaveBeenCalledOnce())

    finishRename(new Error('transport disconnected after server reply'))

    await expect(publishing).resolves.toBeUndefined()
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(session.lstat).toHaveBeenCalledTimes(2)
  })

  it('reports a true conflict when both paths remain after a submitted rename error', async () => {
    const hostId = asHostId('ssh:transfer-rename-conflict')
    const source = hostPath(hostId, '/project/source')
    const destination = hostPath(hostId, '/project/destination')
    let finishRename!: (error?: Error) => void
    const session = {
      rename: vi.fn(
        (_source: string, _destination: string, callback: typeof finishRename) => {
          finishRename = callback
        },
      ),
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value?: unknown) => void) =>
          callback(undefined, {
            mode: 0o100644,
            mtime: 100,
            size: 5,
            atime: 100,
          }),
      ),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const publishing = files.renameProjectFileNoReplace(source, destination)
    await vi.waitFor(() => expect(session.rename).toHaveBeenCalledOnce())

    finishRename(new Error('destination exists'))

    await expect(publishing).rejects.toMatchObject({ code: 'EEXIST' })
    expect(session.lstat).toHaveBeenCalledTimes(2)
  })

  it('does not submit a no-replace rename cancelled while SFTP opens', async () => {
    const hostId = asHostId('ssh:transfer-rename-opening')
    const source = hostPath(hostId, '/project/source')
    const destination = hostPath(hostId, '/project/destination')
    let resolveSession!: (session: SFTPWrapper) => void
    const opening = new Promise<SFTPWrapper>((resolve) => {
      resolveSession = resolve
    })
    const session = {
      rename: vi.fn(),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess({ hostId, openSftp: () => opening }, {})
    const controller = new AbortController()
    const onSubmitted = vi.fn()
    const publishing = files.renameProjectFileNoReplace(source, destination, {
      signal: controller.signal,
      onSubmitted,
    })

    controller.abort()
    resolveSession(session as unknown as SFTPWrapper)

    await expect(publishing).rejects.toMatchObject({ name: 'AbortError' })
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(session.rename).not.toHaveBeenCalled()
  })

  it('does not mark a synchronously rejected SFTP rename as submitted', async () => {
    const hostId = asHostId('ssh:transfer-rename-sync-throw')
    const source = hostPath(hostId, '/project/source')
    const destination = hostPath(hostId, '/project/destination')
    const session = {
      rename: vi.fn(() => {
        throw new Error('transport rejected before submission')
      }),
      once: vi.fn(),
      end: vi.fn(),
    }
    const files = new SshFileAccess(
      { hostId, openSftp: () => Promise.resolve(session as unknown as SFTPWrapper) },
      {},
    )
    const onSubmitted = vi.fn()

    await expect(
      files.renameProjectFileNoReplace(source, destination, { onSubmitted }),
    ).rejects.toThrow('before submission')
    expect(onSubmitted).not.toHaveBeenCalled()
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

  it('reads a bounded text prefix and discloses remote truncation', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/file.txt')
    const session = {
      createReadStream: vi.fn(() => Readable.from([Buffer.from('abcde')])),
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

    await expect(files.readTextFilePrefix(path, 4)).resolves.toMatchObject({
      content: 'abcd',
      byteLength: 4,
      complete: false,
    })
    expect(session.createReadStream).toHaveBeenCalledWith(path.path, {
      start: 0,
      end: 4,
    })
    files.dispose()
  })

  it('rejects a bounded text prefix when the SSH stream closes before ending', async () => {
    const hostId = asHostId('ssh:test')
    const path = hostPath(hostId, '/project/file.txt')
    const stream = new PassThrough()
    const session = {
      createReadStream: vi.fn(() => stream),
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

    const reading = files.readTextFilePrefix(path, 4)
    await vi.waitFor(() => expect(session.createReadStream).toHaveBeenCalledOnce())
    stream.destroy()

    await expect(reading).rejects.toThrow('closed before completion')
    files.dispose()
  })
})

async function* emptyChunks(): AsyncIterable<Uint8Array> {}

async function* oneChunk(): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield Buffer.from('one')
}

function fileAccess(
  openSftp: () => Promise<SFTPWrapper> = () =>
    Promise.reject(new Error('SFTP is not configured for this test')),
): SshFileAccess {
  return new SshFileAccess({ hostId: asHostId('example'), openSftp }, {})
}
