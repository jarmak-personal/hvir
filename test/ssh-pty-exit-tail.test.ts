import { createHash, generateKeyPairSync } from 'node:crypto'
import { Server, type Connection, type ServerChannel } from 'ssh2'
import { describe, expect, it } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { hostPath } from '../src/shared/host-path'
import { createTestSshHost } from './ssh-host-test-fixture'

const BLOCK = '0123456789abcdef'.repeat(4096)
const MARKER = 'HVIR_FINAL_1114_SSH_f729c8e1'
const key = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey

describe('real loopback SSH PTY exit drain', () => {
  it.each([
    ['baseline', 1],
    ['fast', 1],
    ['delayed', 1],
    ['delayed', 17],
    ['immediate', 1],
  ] as const)(
    'preserves exact output for %s consumer across %i blocks',
    async (mode, blocks) => {
      const connections = new Set<Connection>(),
        channels = new Set<ServerChannel>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let serverBytes = 0,
        commands = 0
      const failures: unknown[] = []
      const server = new Server({ hostKeys: [key] }, (client) => {
        connections.add(client)
        client.on('error', () => undefined)
        client.on('close', () => connections.delete(client))
        client.on('authentication', (context) => {
          if (context.method === 'password' && context.password === 'owned-fixture-only')
            context.accept()
          else context.reject(['password'])
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
              // Consume only client input, independently of the client's output pause.
              stream.resume()
              if (!terminal) {
                stream.write('/bin/sh\n')
                stream.exit(0)
                stream.end()
                return
              }
              commands++
              const writeOutput = (): void => {
                void (async () => {
                  for (let block = 0; block < blocks; block++) {
                    for (let offset = 0; offset < BLOCK.length; offset += 1024) {
                      const text = BLOCK.slice(offset, offset + 1024)
                      await new Promise<void>((resolve, reject) =>
                        stream.write(text, (error?: Error | null) =>
                          error ? reject(error) : resolve(),
                        ),
                      )
                      serverBytes += text.length
                    }
                  }
                  await new Promise<void>((resolve, reject) =>
                    stream.write(MARKER, (error?: Error | null) =>
                      error ? reject(error) : resolve(),
                    ),
                  )
                  serverBytes += MARKER.length
                  // All protocol data precedes status and EOF; no fixture pacing workaround.
                  stream.exit(0)
                  stream.end()
                })().catch((error: unknown) => failures.push(error))
              }
              if (mode === 'immediate') writeOutput()
              else {
                const timer = setTimeout(() => {
                  timers.delete(timer)
                  writeOutput()
                }, 100)
                timers.add(timer)
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
          alias: 'owned-exit-tail',
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
      const expectedBytes = BLOCK.length * blocks + MARKER.length
      const expected = createHash('sha256')
      for (let i = 0; i < blocks; i++) expected.update(BLOCK)
      expected.update(MARKER)
      const expectedHash = expected.digest('hex')
      const decoded = createHash('sha256'),
        native = createHash('sha256')
      let decodedBytes = 0,
        nativeBytes = 0,
        decodedTail = '',
        nativeTail = ''
      let active = 0,
        maxActive = 0,
        maxBatch = 0,
        exitCode: number | undefined
      let finish!: () => void, fail!: (error: unknown) => void
      const done = new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      void done.catch(() => undefined)
      const cancellation = new AbortController()
      const deadline = setTimeout(() => {
        cancellation.abort()
        fail(new Error('loopback-tail-timeout'))
      }, 12000)
      try {
        await host.connect()
        supervisor.onExit((_info, exit) => {
          exitCode = exit.exitCode
          if (mode === 'baseline') finish()
        })
        const root = hostPath(host.hostId, '/owned-fixture')
        const info = await supervisor.spawn({
          host,
          provider: plainShellProvider,
          cwd: root,
          ownerId: 17,
          signal: cancellation.signal,
          launchSpec: { file: '/owned-fixture-command', args: [] },
          ...(mode === 'baseline'
            ? {}
            : {
                prepareTerminal: () =>
                  Promise.resolve({
                    columns: 80,
                    rows: 24,
                    connect() {},
                    async output(text: string) {
                      maxBatch = Math.max(maxBatch, Buffer.byteLength(text))
                      maxActive = Math.max(maxActive, ++active)
                      try {
                        if (
                          mode === 'delayed' &&
                          nativeBytes >= BLOCK.length * blocks - 5536
                        )
                          await new Promise<void>((resolve) => setTimeout(resolve, 500))
                        native.update(text)
                        nativeBytes += Buffer.byteLength(text)
                        nativeTail = (nativeTail + text).slice(-MARKER.length)
                      } finally {
                        active--
                      }
                    },
                    exited() {
                      finish()
                      return Promise.resolve()
                    },
                    failed: fail,
                    dispose: () => Promise.resolve(),
                  }),
              }),
        })
        supervisor.attach(info.id, 17, {
          onData(text) {
            decoded.update(text)
            decodedBytes += Buffer.byteLength(text)
            decodedTail = (decodedTail + text).slice(-MARKER.length)
          },
        })
        await done
        expect(commands).toBe(1)
        expect(serverBytes).toBe(expectedBytes)
        expect(decodedBytes).toBe(expectedBytes)
        expect(decoded.digest('hex')).toBe(expectedHash)
        expect(decodedTail).toBe(MARKER)
        expect(exitCode).toBe(0)
        expect(supervisor.get(info.id)).toBeUndefined()
        if (mode !== 'baseline') {
          expect(nativeBytes).toBe(expectedBytes)
          expect(native.digest('hex')).toBe(expectedHash)
          expect(nativeTail).toBe(MARKER)
          expect(maxActive).toBe(1)
          expect(maxBatch).toBeLessThanOrEqual(128 * 1024)
        }
        expect(failures).toEqual([])
      } finally {
        clearTimeout(deadline)
        for (const timer of timers) clearTimeout(timer)
        const closedConnections = [...connections].map(
          (connection) =>
            new Promise<void>((resolve) => connection.once('close', resolve)),
        )
        await supervisor.disposeAllAndWait()
        await host.dispose()
        for (const stream of channels) stream.destroy()
        for (const connection of connections) connection.end()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await Promise.all(closedConnections)
      }
      expect(server.address()).toBeNull()
      expect(connections.size).toBe(0)
    },
    15000,
  )
})
