import { createHash, generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { Server, type ClientChannel, type Connection, type ServerChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import {
  PtyWriteConfirmedRevokedError,
  PtyWriteResourceSettlementError,
} from '../src/main/project-host/project-host'
import { createSshPtyProcess } from '../src/main/project-host/ssh-pty-process'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { hostPath } from '../src/shared/host-path'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SSH PTY physical write settlement', () => {
  it('keeps healthy backpressure pending without a wall-clock failure or timer', async () => {
    const f = deferredChannel()
    vi.useFakeTimers()
    try {
      const before = vi.getTimerCount()
      let outcome: 'pending' | 'confirmed' | 'failed' = 'pending'
      const pending = f.process.writeConfirmed(Uint8Array.of(0, 255, 128))
      void pending.then(
        () => {
          outcome = 'confirmed'
        },
        () => {
          outcome = 'failed'
        },
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(outcome).toBe('pending')
      expect(vi.getTimerCount()).toBe(before)
      expect(f.channel.write).toHaveBeenCalledExactlyOnceWith(
        Buffer.from([0, 255, 128]),
        expect.any(Function),
      )
      f.complete()
      await pending
      expect(outcome).toBe('confirmed')
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      f.process.kill()
      vi.useRealTimers()
    }
  })

  it.each(['exit', 'close', 'transport', 'kill'] as const)(
    'keeps %s delivery unknown and settles exact resource ownership only on physical completion',
    async (boundary) => {
      const f = deferredChannel()
      const stopTransport = vi.fn()
      let failTransport!: () => void
      f.process.bindTransportFailure((fail) => {
        failTransport = fail
        return stopTransport
      })
      const pending = f.process.writeConfirmed('one exact write')
      const rejected = pending.catch((error: unknown) => error)
      if (boundary === 'transport') failTransport()
      else if (boundary === 'kill') f.process.kill()
      else f.channel.emit(boundary, 9)
      const error = await rejected
      expect(error).toBeInstanceOf(PtyWriteResourceSettlementError)
      let resourcesSettled = false
      const receipt = (error as PtyWriteResourceSettlementError).resourceSettlement.then(
        () => {
          resourcesSettled = true
        },
      )
      await Promise.resolve()
      expect(resourcesSettled).toBe(boundary === 'close')
      expect(f.process.inputClosed).toBe(true)
      f.complete()
      await receipt
      expect(resourcesSettled).toBe(true)
      f.channel.emit('close')
      expect(f.channel.write).toHaveBeenCalledOnce()
      expect(stopTransport).toHaveBeenCalledOnce()
      for (const event of ['data', 'end', 'exit', 'close'])
        expect(f.channel.listenerCount(event)).toBe(0)
    },
  )

  it('settles a rejected write resource on exact channel close without waiting for a late callback', async () => {
    const f = deferredChannel()
    const pending = f.process
      .writeConfirmed('one exact write')
      .catch((error: unknown) => error)
    f.channel.emit('exit', 7)
    const error = await pending
    expect(error).toBeInstanceOf(PtyWriteResourceSettlementError)
    let physical = false
    const receipt = (error as PtyWriteResourceSettlementError).resourceSettlement.then(
      () => {
        physical = true
      },
    )
    await Promise.resolve()
    expect(physical).toBe(false)
    f.channel.emit('close')
    await receipt
    expect(physical).toBe(true)
    f.complete()
    expect(f.channel.write).toHaveBeenCalledOnce()
    expect(f.channel.listenerCount('close')).toBe(0)
  })

  it('preserves callback refusal without claiming completion or attempting replay', async () => {
    const f = deferredChannel()
    const pending = f.process.writeConfirmed('one exact write')
    const rejected = expect(pending).rejects.toThrow('channel write failed')
    const failure = pending.catch((error: unknown) => error)
    f.complete(new Error('channel write failed'))
    await rejected
    const error = await failure
    expect(error).toBeInstanceOf(PtyWriteResourceSettlementError)
    await (error as PtyWriteResourceSettlementError).resourceSettlement
    expect(f.channel.listenerCount('close')).toBe(1)
    expect(f.channel.write).toHaveBeenCalledOnce()
    expect(f.process.inputClosed).toBe(false)
    f.process.kill()
    f.channel.emit('close')
    expect(f.channel.listenerCount('close')).toBe(0)
  })
  it('proves a known-closed call unsent without settling another write', async () => {
    const f = deferredChannel()
    const earlier = f.process.writeConfirmed('earlier').catch((error: unknown) => error)
    f.channel.emit('exit', 7)
    const prior = (await earlier) as PtyWriteResourceSettlementError
    let previousSettled = false
    void prior.resourceSettlement.then(() => {
      previousSettled = true
    })
    const rejected = await f.process
      .writeConfirmed('never sent')
      .catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(PtyWriteResourceSettlementError)
    await (rejected as PtyWriteResourceSettlementError).resourceSettlement
    expect(previousSettled).toBe(false)
    expect(f.channel.write).toHaveBeenCalledOnce()
    f.channel.emit('close')
    await prior.resourceSettlement
    expect(previousSettled).toBe(true)
    expect(f.channel.listenerCount('close')).toBe(0)
  })
  it('retains a synchronous uncertain write failure until its exact channel closes', async () => {
    const f = deferredChannel()
    f.channel.write.mockImplementationOnce(() => {
      throw new Error('uncertain synchronous write')
    })
    const rejected = await f.process
      .writeConfirmed('one body')
      .catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(PtyWriteResourceSettlementError)
    let physical = false
    const receipt = (rejected as PtyWriteResourceSettlementError).resourceSettlement.then(
      () => {
        physical = true
      },
    )
    await Promise.resolve()
    expect(physical).toBe(false)
    f.channel.emit('close')
    await receipt
    expect(physical).toBe(true)
    expect(f.channel.write).toHaveBeenCalledOnce()
    expect(f.channel.listenerCount('close')).toBe(0)
  })
})

function deferredChannel() {
  let complete!: (error?: Error) => void
  const channel = Object.assign(new EventEmitter(), {
    write: vi.fn((_value: unknown, callback: (error?: Error) => void) => {
      complete = callback
      return false
    }),
    close: vi.fn(),
  })
  return {
    channel,
    process: createSshPtyProcess(channel as unknown as ClientChannel, -1),
    complete: (error?: Error) => complete(error),
  }
}

describe('real SSH2 backpressured confirmed input', () => {
  it.each(['current', 'revoked', 'cancelled', 'disconnected'] as const)(
    'preserves exact backpressured write ownership with %s authority',
    async (authority) => {
      const key = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      }).privateKey
      const connections = new Set<Connection>()
      const channels = new Set<ServerChannel>()
      let held!: ServerChannel
      let totalBytes = 0
      const received = createHash('sha256')
      const body = Buffer.alloc(8 * 1024 * 1024)
      for (let i = 0; i < body.length; i++) body[i] = i % 251
      const expectedHash = createHash('sha256').update(body).digest('hex')
      let finishBody!: () => void
      const bodyReceived = new Promise<void>((resolve) => {
        finishBody = resolve
      })
      let finishIndependent!: () => void
      const independentReceived = new Promise<void>((resolve) => {
        finishIndependent = resolve
      })
      let shells = 0
      const server = new Server({ hostKeys: [key] }, (client) => {
        connections.add(client)
        client.on('error', () => undefined)
        client.on('close', () => connections.delete(client))
        client.on('authentication', (auth) => {
          if (auth.method === 'password' && auth.password === 'owned-fixture-only')
            auth.accept()
          else auth.reject(['password'])
        })
        client.on('ready', () =>
          client.on('session', (accept) => {
            const session = accept()
            let terminal = false
            session.on('pty', (accept) => {
              terminal = true
              accept()
            })
            session.on('env', (accept) => accept?.())
            session.on('exec', (accept) => {
              const stream = accept()
              channels.add(stream)
              stream.on('error', () => undefined)
              stream.on('close', () => channels.delete(stream))
              if (!terminal) {
                stream.resume()
                stream.end('/bin/sh\n')
                stream.exit(0)
              } else if (++shells === 1) {
                held = stream
                // Leave the SSH2 readable unconsumed: its finite receive window fills.
                stream.pause()
              } else {
                stream.on('data', () => finishIndependent())
              }
            })
          }),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('loopback-address')
      const host = createTestSshHost({
        config: {
          alias: 'owned-confirmed-input',
          hostname: '127.0.0.1',
          port: address.port,
          user: 'fixture',
          identityFiles: [],
        },
        agentSocket: '',
        identitySource: { candidatePaths: [], acquire: () => Promise.resolve(undefined) },
        prompter: {
          prompt: (request) =>
            Promise.resolve(
              request.kind === 'host-key'
                ? ['yes']
                : request.kind === 'password'
                  ? ['owned-fixture-only']
                  : undefined,
            ),
        },
      })
      const supervisor = new PtySupervisor()
      const owner = 1120
      try {
        await host.connect()
        const spawn = () =>
          supervisor.spawn({
            host,
            provider: plainShellProvider,
            cwd: hostPath(host.hostId, '/owned-fixture'),
            ownerId: owner,
            ownerGeneration: 1,
            launchSpec: { file: '/owned-fixture-command', args: [] },
          })
        const first = await spawn()
        const second = await spawn()
        supervisor.attach(first.id, owner, { onData() {} }, 1)
        let outcome: 'pending' | 'confirmed' | 'failed' = 'pending'
        const started = performance.now()
        const pending = supervisor.writeConfirmed(first.id, owner, body, 1)
        void pending.then(
          () => {
            outcome = 'confirmed'
          },
          () => {
            outcome = 'failed'
          },
        )
        await supervisor.writeConfirmed(second.id, owner, 'independent')
        await independentReceived
        if (authority === 'current' || authority === 'revoked') {
          // A duration is the contract under test, not a readiness surrogate.
          await new Promise<void>((resolve) => setTimeout(resolve, 5_500))
          expect(performance.now() - started).toBeGreaterThan(5_000)
        } else await vi.waitFor(() => expect(held.readableLength).toBeGreaterThan(0))
        expect(outcome).toBe('pending')
        expect(host.connectionState).toBe('connected')
        expect(supervisor.get(first.id)).toBe(first)
        if (authority === 'cancelled' || authority === 'disconnected') {
          if (authority === 'cancelled') supervisor.disposeSession(first.id, owner, 1)
          else for (const connection of connections) connection.end()
          const error = await pending.catch((error: unknown) => error)
          expect(error).toBeInstanceOf(PtyWriteResourceSettlementError)
          await (error as PtyWriteResourceSettlementError).resourceSettlement
          expect(outcome).toBe('failed')
          // The remote receiver never drained the write, so delivery is unknown.
          expect(shells).toBe(2)
          return
        }
        if (authority === 'revoked') {
          expect(supervisor.transferRendererSession(first.id, owner, 1, owner, 2)).toBe(
            true,
          )
          const replacement = supervisor.get(first.id)
          expect(replacement?.instanceId).toBe(first.instanceId)
          expect(replacement?.pid).toBe(first.pid)
          await expect(
            supervisor.writeConfirmed(first.id, owner, 'stale', 1),
          ).rejects.toThrow(/another renderer/)
        }
        held.on('data', (bytes: Buffer) => {
          totalBytes += bytes.length
          received.update(bytes)
          if (totalBytes >= body.length) finishBody()
        })
        held.resume()
        if (authority === 'current') await pending
        else await expect(pending).rejects.toBeInstanceOf(PtyWriteConfirmedRevokedError)
        await bodyReceived
        expect(outcome).toBe(authority === 'current' ? 'confirmed' : 'failed')
        expect(totalBytes).toBe(body.length)
        expect(received.digest('hex')).toBe(expectedHash)
        expect(shells).toBe(2)
      } finally {
        const closedConnections = [...connections].map(
          (connection) =>
            new Promise<void>((resolve) => connection.once('close', resolve)),
        )
        const closedChannels = [...channels].map(
          (channel) => new Promise<void>((resolve) => channel.once('close', resolve)),
        )
        await supervisor.disposeAllAndWait()
        await host.dispose()
        for (const channel of channels) {
          // Cancellation deliberately leaves the disposable server receiver paused.
          // Drain its buffered partial input only for fixture resource disposal.
          channel.resume()
          channel.destroy()
        }
        for (const connection of connections) connection.end()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await Promise.all([...closedConnections, ...closedChannels])
        expect(server.address()).toBeNull()
        expect(channels.size).toBe(0)
        expect(connections.size).toBe(0)
        expect(supervisor.list()).toEqual([])
        expect(host.transportDiagnostics()).toEqual([])
      }
    },
    15_000,
  )
})
