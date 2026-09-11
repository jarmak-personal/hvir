import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SSH buffered execution per-stream bounds', () => {
  it.each(['stdout', 'stderr'] as const)(
    'applies the %s byte bound independently of the combined buffer',
    async (stream) => {
      const client = Object.assign(new EventEmitter(), {
        connect: () => queueMicrotask(() => client.emit('ready')),
        end: () => client.emit('close'),
        destroy: () => client.emit('close'),
        exec: (
          command: string,
          callback: (error: Error | undefined, channel: unknown) => void,
        ) => {
          const channel = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            close: () => queueMicrotask(() => channel.emit('close')),
            end: () =>
              queueMicrotask(() => {
                if (command.includes('budget-probe'))
                  (stream === 'stdout' ? channel : channel.stderr).emit(
                    'data',
                    Buffer.from('123456'),
                  )
                channel.emit('exit', 0)
                channel.emit('close')
              }),
          })
          callback(undefined, channel)
        },
      })
      const host = createTestSshHost({
        config: {
          alias: 'budget',
          hostname: 'budget.invalid',
          user: 'fixture',
          port: 22,
          identityFiles: [],
        },
        prompter: { prompt: () => Promise.resolve(undefined) },
        clientFactory: () => client as unknown as Client,
      })
      try {
        await host.connect()
        await expect(
          host.exec('budget-probe', [], {
            maxBuffer: 100,
            [stream === 'stdout' ? 'maxStdoutBytes' : 'maxStderrBytes']: 5,
          }),
        ).rejects.toThrow('exceeded maxBuffer')
        await expect(host.exec('true', [])).resolves.toMatchObject({ code: 0 })
      } finally {
        await host.dispose()
      }
    },
  )
})
