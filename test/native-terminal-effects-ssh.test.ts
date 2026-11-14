import { createHash, generateKeyPairSync } from 'node:crypto'
import { Server, type Connection, type ServerChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import { NativeTerminalEffectPolicy } from '../src/main/terminal/native-terminal-effect-policy'
import { hostPath } from '../src/shared/host-path'
import type { NativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
import { createTestSshHost } from './ssh-host-test-fixture'

const key = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey
const payload =
  '\x1b]52;pc;bmF0aXZlLWVmZmVjdHM=\x1b\\\x1b]7;file://remote-fixture.invalid/work/effects\x1b\\'
/** Real SSH transport/supervisor/consumer/policy, immediate native-result dependency.
 * Native parsing is proved separately; this fixture never parses escape sequences. */
describe('native effect authority over disposable loopback SSH', () => {
  it.each(['live', 'physically-exited'] as const)(
    'uses current physical source authority for %s effects',
    async (mode) => {
      const connections = new Set<Connection>(),
        channels = new Set<ServerChannel>()
      let channel: ServerChannel | undefined,
        commands = 0
      const server = new Server({ hostKeys: [key] }, (client) => {
        connections.add(client)
        client.on('error', () => undefined)
        client.on('close', () => connections.delete(client))
        client.on('authentication', (request) =>
          request.method === 'password' && request.password === 'owned-effects-only'
            ? request.accept()
            : request.reject(['password']),
        )
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
              stream.resume()
              if (!terminal) {
                stream.write('/bin/sh\n')
                stream.exit(0)
                stream.end()
                return
              }
              channel = stream
              commands++
              stream.write(payload, () => {
                if (mode === 'physically-exited') {
                  stream.exit(0)
                  stream.end()
                }
              })
            })
          }),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('owned-loopback-address')
      const host = createTestSshHost({
        config: {
          alias: 'owned-effects',
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
                  ? ['owned-effects-only']
                  : undefined,
            ),
        },
      })
      const supervisor = new PtySupervisor(),
        clipboard = vi.fn(),
        publish = vi.fn()
      const policy = new NativeTerminalEffectPolicy({ writeText: clipboard }, publish)
      let release!: (batch: NativeTerminalEffectBatch) => void
      const pending = new Promise<NativeTerminalEffectBatch>((resolve) => {
        release = resolve
      })
      let draining = false,
        sequence = 0,
        bytes = 0
      const digest = createHash('sha256')
      const initial = nativeTerminalStatus()
      const status = {
        ...initial,
        geometry: { ...initial.geometry, width: 640, height: 400, columns: 80, rows: 25 },
      }
      const nativeHost = {
        prepare: () => Promise.resolve('owned-native-handle'),
        inspectProducer: () =>
          Promise.resolve({
            ...status,
            appliedSequence: sequence,
            ioAppliedSequence: sequence,
          }),
        resizeProducer: () => Promise.resolve(status),
        feed: (_handle: string, _instance: string, chunk: Uint8Array) => {
          sequence++
          bytes += chunk.byteLength
          digest.update(chunk)
          return Promise.resolve()
        },
        drainReplies: () => Promise.resolve(new Uint8Array()),
        drainEffectsProducer: () => {
          draining = true
          return pending
        },
        end: () => Promise.resolve(),
      }
      const sessions = new NativeTerminalSessions(
        nativeHost,
        () => true,
        undefined,
        policy,
      )
      let observedHost: string | undefined, observedInstance: string | undefined
      const stop = policy.observe(({ session }) => {
        observedHost = session.workspaceRoot.hostId
        observedInstance = session.instanceId
      })
      let info: Awaited<ReturnType<PtySupervisor['spawn']>> | undefined
      const cancellation = new AbortController()
      const deadline = setTimeout(() => cancellation.abort(), 10000)
      try {
        await host.connect()
        info = await supervisor.spawn({
          host,
          provider: plainShellProvider,
          cwd: hostPath(host.hostId, '/owned-effects'),
          ownerId: 17,
          signal: cancellation.signal,
          launchSpec: { file: '/owned-effects-command', args: [] },
          prepareTerminal: (reservation, signal) =>
            sessions.prepare(reservation, signal, {
              width: 640,
              height: 400,
              backingScale: 1,
            }),
        })
        await vi.waitFor(() => expect(draining).toBe(true))
        if (mode === 'physically-exited')
          await vi.waitFor(() => expect(sessions.get(info!.id)?.inputClosed).toBe(true))
        const batch: NativeTerminalEffectBatch = {
          effects: [
            {
              kind: 'clipboard',
              protocol: 'osc-52',
              selection: 'pc',
              data: 'bmF0aXZlLWVmZmVjdHM=',
              eventSerial: 1,
              sequence,
            },
            {
              kind: 'cwd',
              uri: 'file://remote-fixture.invalid/work/effects',
              eventSerial: 2,
              sequence,
            },
          ],
          droppedEffects: 0,
          semanticGeneration: 0,
        }
        release(batch)
        await vi.waitFor(() => expect(observedInstance).toBe(info!.instanceId))
        expect(observedHost).toBe(host.hostId)
        expect(bytes).toBe(Buffer.byteLength(payload))
        expect(digest.digest('hex')).toBe(
          createHash('sha256').update(payload).digest('hex'),
        )
        expect(commands).toBe(1)
        if (mode === 'live') {
          expect(clipboard).toHaveBeenCalledExactlyOnceWith('native-effects')
          channel!.exit(0)
          channel!.end()
        } else expect(clipboard).not.toHaveBeenCalled()
        expect(publish).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(supervisor.get(info!.id)).toBeUndefined())
        await vi.waitFor(() => expect(sessions.get(info!.id)?.readonly).toBe(true))
      } finally {
        release({ effects: [], droppedEffects: 0, semanticGeneration: 0 })
        clearTimeout(deadline)
        stop()
        cancellation.abort()
        await supervisor.disposeAllAndWait()
        if (info) await sessions.remove(info.id, info.instanceId)
        const closed = [...connections].map(
          (connection) =>
            new Promise<void>((resolve) => connection.once('close', resolve)),
        )
        await host.dispose()
        for (const stream of channels) stream.destroy()
        for (const connection of connections) connection.end()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await Promise.all(closed)
      }
      expect(server.address()).toBeNull()
      expect(connections.size).toBe(0)
      expect(channels.size).toBe(0)
    },
    15000,
  )
})
