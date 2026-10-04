import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'

import type { Client, SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { hostPath } from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

// Use ssh2's real stream factories; only their immediate SFTP channel is fake.
const { SFTP } = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js') as {
  SFTP: { prototype: Pick<SFTPWrapper, 'createReadStream' | 'createWriteStream'> }
}

describe('SshHost SFTP stream lifecycle', () => {
  it.each(['open', 'read', 'close'] as const)(
    'survives socket loss during prefix %s',
    async (phase) => {
      const fixture = await hostFixture()
      try {
        const result = observe(fixture.host.readTextFilePrefix(fixture.path, 4))
        const opening = await fixture.channel.take('open')
        if (phase !== 'open') {
          opening.complete()
          const reading = await fixture.channel.take('read')
          if (phase === 'close') {
            reading.complete()
            await expect(result.promise).resolves.toMatchObject({
              value: { content: 'abc' },
            })
            await fixture.channel.take('close')
          }
        }

        expect(() => fixture.channel.dropSocket()).not.toThrow()
        if (phase !== 'close') {
          await expect(result.promise).resolves.toEqual({
            error: fixture.channel.failure,
          })
        }
        await nextTurn()
        expect(result.settled).toHaveBeenCalledOnce()
      } finally {
        await fixture.host.dispose()
      }
    },
  )

  it.each(['open', 'read'] as const)(
    'preserves prefix abort with %s pending during socket loss',
    async (phase) => {
      const fixture = await hostFixture()
      const controller = new AbortController()
      const reason = new Error('prefix owner revoked')
      try {
        const result = observe(
          fixture.host.readTextFilePrefix(fixture.path, 4, { signal: controller.signal }),
        )
        const opening = await fixture.channel.take('open')
        if (phase === 'read') {
          opening.complete()
          await fixture.channel.take('read')
        }
        controller.abort(reason)
        await expect(result.promise).resolves.toEqual({ error: reason })

        expect(() => fixture.channel.dropSocket()).not.toThrow()
        await nextTurn()
        expect(result.settled).toHaveBeenCalledOnce()
      } finally {
        await fixture.host.dispose()
      }
    },
  )

  it('releases prefix operation listeners after a successful CLOSE', async () => {
    const fixture = await hostFixture()
    try {
      const reading = fixture.host.readTextFilePrefix(fixture.path, 4)
      ;(await fixture.channel.take('open')).complete()
      ;(await fixture.channel.take('read')).complete()
      await expect(reading).resolves.toMatchObject({ content: 'abc' })
      const stream = fixture.channel.streams[0]!
      ;(await fixture.channel.take('close')).complete()
      await nextTurn()
      expect(stream.listenerCount('error')).toBe(1)
      expect(() => stream.emit('error', new Error('late stream failure'))).not.toThrow()
      expect(stream.listenerCount('close')).toBe(0)
    } finally {
      await fixture.host.dispose()
    }
  })

  it('contains a pending READ failure even when aborted CLOSE has already succeeded', async () => {
    const fixture = await hostFixture()
    const controller = new AbortController()
    try {
      const result = observe(
        fixture.host.readTextFilePrefix(fixture.path, 4, {
          signal: controller.signal,
        }),
      )
      ;(await fixture.channel.take('open')).complete()
      await fixture.channel.take('read')
      controller.abort()
      await expect(result.promise).resolves.toMatchObject({
        error: { name: 'AbortError' },
      })
      ;(await fixture.channel.take('close')).complete()
      await nextTurn()

      expect(() => fixture.channel.dropSocket()).not.toThrow()
      await nextTurn()
      expect(result.settled).toHaveBeenCalledOnce()
    } finally {
      await fixture.host.dispose()
    }
  })

  it.each(['open', 'write', 'close'] as const)(
    'rejects signalled writes on socket loss during %s',
    async (phase) => {
      const fixture = await hostFixture()
      try {
        const result = observe(
          fixture.host.writeFile(fixture.path, 'abc', {
            signal: new AbortController().signal,
          }),
        )
        const opening = await fixture.channel.take('open')
        if (phase !== 'open') {
          opening.complete()
          const writing = await fixture.channel.take('write')
          if (phase === 'close') {
            writing.complete()
            await fixture.channel.take('close')
            await nextTurn()
            expect(result.settled).not.toHaveBeenCalled()
          }
        }

        expect(() => fixture.channel.dropSocket()).not.toThrow()
        await expect(result.promise).resolves.toEqual({ error: fixture.channel.failure })
        await nextTurn()
        expect(result.settled).toHaveBeenCalledOnce()
        expect(fixture.channel.rename).not.toHaveBeenCalled()
      } finally {
        await fixture.host.dispose()
      }
    },
  )

  it.each(['open', 'write', 'close'] as const)(
    'preserves write abort with %s pending during socket loss',
    async (phase) => {
      const fixture = await hostFixture()
      const controller = new AbortController()
      try {
        const result = observe(
          fixture.host.writeFile(fixture.path, 'abc', { signal: controller.signal }),
        )
        const opening = await fixture.channel.take('open')
        if (phase !== 'open') {
          opening.complete()
          const writing = await fixture.channel.take('write')
          if (phase === 'close') {
            writing.complete()
            await fixture.channel.take('close')
          }
        }
        const reason = phase === 'close' ? new Error('write owner revoked') : undefined
        controller.abort(reason)
        if (reason) await expect(result.promise).resolves.toEqual({ error: reason })
        else
          await expect(result.promise).resolves.toMatchObject({
            error: { name: 'AbortError' },
          })

        expect(() => fixture.channel.dropSocket()).not.toThrow()
        await nextTurn()
        expect(result.settled).toHaveBeenCalledOnce()
        expect(fixture.channel.rename).not.toHaveBeenCalled()
      } finally {
        await fixture.host.dispose()
      }
    },
  )

  it('publishes a signalled write only after CLOSE succeeds and releases listeners', async () => {
    const fixture = await hostFixture()
    try {
      const result = observe(
        fixture.host.writeFile(fixture.path, 'abc', {
          signal: new AbortController().signal,
        }),
      )
      ;(await fixture.channel.take('open')).complete()
      ;(await fixture.channel.take('write')).complete()
      const closing = await fixture.channel.take('close')
      await nextTurn()
      expect(result.settled).not.toHaveBeenCalled()
      expect(fixture.channel.rename).not.toHaveBeenCalled()

      closing.complete()
      await expect(result.promise).resolves.toEqual({ value: undefined })
      expect(fixture.channel.rename).toHaveBeenCalledOnce()
      const stream = fixture.channel.streams[0]!
      expect(stream.listenerCount('error')).toBe(1)
      expect(stream.listenerCount('close')).toBe(0)
    } finally {
      await fixture.host.dispose()
    }
  })

  it('contains session errors and replaces only the failed cached session', async () => {
    const fixture = await hostFixture()
    try {
      await fixture.host.stat(fixture.path)
      expect(fixture.client.sftp).toHaveBeenCalledTimes(1)
      expect(fixture.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ channels: 1 }),
      ])
      expect(() =>
        fixture.channel.session.emit('error', new Error('fatal SFTP protocol error')),
      ).not.toThrow()
      await fixture.host.stat(fixture.path)
      expect(fixture.client.sftp).toHaveBeenCalledTimes(2)
      expect(fixture.channel.session.end).toHaveBeenCalledOnce()
      expect(fixture.host.connectionState).toBe('connected')
      expect(fixture.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ channels: 2 }),
      ])

      // Late failure/close on the old channel must not invalidate the replacement.
      expect(() =>
        fixture.channel.session.emit('error', new Error('late session error')),
      ).not.toThrow()
      fixture.channel.session.emit('close')
      expect(fixture.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ channels: 1 }),
      ])
      await fixture.host.stat(fixture.path)
      expect(fixture.client.sftp).toHaveBeenCalledTimes(2)
      expect(fixture.channel.session.listenerCount('error')).toBe(1)
    } finally {
      await fixture.host.dispose()
    }
  })

  it('rejects a session that fails during acquisition and opens a fresh session next time', async () => {
    const fixture = await hostFixture()
    const failure = new Error('SFTP protocol failed at acquisition')
    fixture.client.sftp
      .mockReset()
      .mockImplementationOnce((done: (error: undefined, session: unknown) => void) => {
        done(undefined, fixture.channel.session)
        fixture.channel.session.emit('error', failure)
      })
      .mockImplementation((done: (error: undefined, session: unknown) => void) =>
        done(undefined, sftpChannel().session),
      )
    try {
      await expect(fixture.host.stat(fixture.path)).rejects.toBe(failure)
      await expect(fixture.host.stat(fixture.path)).resolves.toMatchObject({
        type: 'file',
      })
      expect(fixture.client.sftp).toHaveBeenCalledTimes(2)
      expect(fixture.channel.session.end).toHaveBeenCalledOnce()
    } finally {
      await fixture.host.dispose()
    }
  })

  it('contains session errors emitted during host disposal', async () => {
    const fixture = await hostFixture()
    await fixture.host.stat(fixture.path)
    fixture.channel.session.end.mockImplementation(() => {
      fixture.channel.session.emit('error', new Error('session failed during disposal'))
    })
    await expect(fixture.host.dispose()).resolves.toBeUndefined()
    await nextTurn()
    expect(fixture.channel.session.end).toHaveBeenCalledTimes(2)
  })
})

type Phase = 'open' | 'read' | 'write' | 'close'
type Request = { complete(error?: Error): void }

function sftpChannel() {
  const failure = new Error('No response from server')
  const pending = new Map<Phase, Request[]>()
  const waiting = new Map<Phase, (request: Request) => void>()
  const streams: EventEmitter[] = []
  let closed = false
  const submit = (phase: Phase, complete: (error?: Error) => void) => {
    const request = { complete }
    if (closed) {
      queueMicrotask(() => complete(failure))
      return
    }
    const requests = pending.get(phase) ?? []
    requests.push(request)
    pending.set(phase, requests)
    waiting.get(phase)?.(request)
    waiting.delete(phase)
  }
  const rename = vi.fn(
    (_source: string, _target: string, done: (error?: Error) => void) => done(),
  )
  const session = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    createReadStream(
      path: string,
      options: Parameters<SFTPWrapper['createReadStream']>[1],
    ) {
      const stream = SFTP.prototype.createReadStream.call(
        this as unknown as SFTPWrapper,
        path,
        options,
      )
      streams.push(stream)
      return stream
    },
    createWriteStream(
      path: string,
      options: Parameters<SFTPWrapper['createWriteStream']>[1],
    ) {
      const stream = SFTP.prototype.createWriteStream.call(
        this as unknown as SFTPWrapper,
        path,
        options,
      )
      streams.push(stream)
      return stream
    },
    open: (
      _path: string,
      _flags: string,
      _mode: number,
      done: (error?: Error, handle?: Buffer) => void,
    ) =>
      submit('open', (error) => done(error, error ? undefined : Buffer.from('handle'))),
    read: (
      _handle: Buffer,
      buffer: Buffer,
      offset: number,
      _length: number,
      position: number,
      done: (error?: Error, bytes?: number) => void,
    ) => {
      if (position > 0) return queueMicrotask(() => done(undefined, 0))
      submit('read', (error) =>
        done(error, error ? undefined : buffer.write('abc', offset)),
      )
    },
    write: (
      _handle: Buffer,
      _buffer: Buffer,
      _offset: number,
      length: number,
      _position: number,
      done: (error?: Error, bytes?: number) => void,
    ) => submit('write', (error) => done(error, error ? undefined : length)),
    close: (_handle: Buffer, done: (error?: Error) => void) => submit('close', done),
    fchmod: (_handle: Buffer, _mode: number, done: () => void) => queueMicrotask(done),
    lstat: (_path: string, done: (error: undefined, attrs: unknown) => void) =>
      done(undefined, { mode: 0o100644, size: 3, mtime: 1 }),
    ext_openssh_rename: rename,
    unlink: (_path: string, done: () => void) => done(),
  })
  return {
    session,
    streams,
    failure,
    rename,
    take(phase: Phase): Promise<Request> {
      const take = (request: Request): Request => {
        // Taking a request observes submission; it remains pending until replied to.
        return {
          complete: (error) => {
            const requests = pending.get(phase)!
            requests.splice(requests.indexOf(request), 1)
            request.complete(error)
          },
        }
      }
      const request = pending.get(phase)?.[0]
      if (request) return Promise.resolve(take(request))
      return new Promise((resolve) => waiting.set(phase, (value) => resolve(take(value))))
    },
    dropSocket() {
      closed = true
      // Mirror ssh2 cleanupRequests: detach the pending set, then fail every callback.
      const requests = [...pending.values()].flat()
      pending.clear()
      for (const request of requests) request.complete(failure)
    },
  }
}

async function hostFixture() {
  const channel = sftpChannel()
  const replacement = sftpChannel()
  const client = Object.assign(new EventEmitter(), {
    connect: () => queueMicrotask(() => client.emit('ready')),
    end: () => client.emit('close'),
    destroy: () => client.emit('close'),
    sftp: vi
      .fn()
      .mockImplementationOnce((done: (error: undefined, session: unknown) => void) =>
        done(undefined, channel.session),
      )
      .mockImplementation((done: (error: undefined, session: unknown) => void) =>
        done(undefined, replacement.session),
      ),
    exec: (_command: string, done: (error: undefined, stream: unknown) => void) => {
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: () => stream.emit('close'),
        end: () =>
          setImmediate(() => {
            stream.emit('exit', 1)
            stream.emit('close')
          }),
      })
      done(undefined, stream)
    },
  })
  const host = createTestSshHost({
    config: {
      alias: 'ssh:sftp-lifecycle',
      hostname: 'test.invalid',
      user: 'test',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
    clientFactory: () => client as unknown as Client,
  })
  await host.connect()
  return { host, channel, client, path: hostPath(host.hostId, '/project/file.txt') }
}

function observe<T>(operation: Promise<T>) {
  const settled = vi.fn()
  const promise = operation.then(
    (value) => {
      settled()
      return { value }
    },
    (error: unknown) => {
      settled()
      return { error }
    },
  )
  return { promise, settled }
}
