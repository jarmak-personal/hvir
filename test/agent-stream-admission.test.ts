import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { AgentStreamAdmission } from '../src/main/agent/stream-admission'
import { AGENT_LIMITS, agentOutput } from '../src/shared/agent/contract'
import { asHostId } from '../src/shared/host-path'
it('local and forwarded streams share the application connection budget and both revoke', async () => {
  const dispatch = vi.fn(() => Promise.resolve(agentOutput({}))),
    admission = new AgentStreamAdmission(dispatch),
    generation = new AbortController(),
    streams = []
  for (let index = 0; index < AGENT_LIMITS.connections; index++) {
    const stream = new PassThrough()
    streams.push(stream)
    admission.accept(
      stream,
      index % 2
        ? {
            origin: 'ssh-forward',
            host: asHostId('ssh'),
            generation: 'object:1',
            current: () => generation.signal.throwIfAborted(),
          }
        : { origin: 'application-local' },
      index % 2 ? generation.signal : undefined,
    )
  }
  const overflow = new PassThrough()
  admission.accept(overflow, { origin: 'application-local' })
  expect(overflow.destroyed).toBe(true)
  generation.abort()
  await new Promise<void>((done) => setImmediate(done))
  expect(streams.filter((stream) => stream.destroyed)).toHaveLength(
    AGENT_LIMITS.connections / 2,
  )
  const accepted = new PassThrough()
  admission.accept(accepted, { origin: 'application-local' })
  expect(accepted.destroyed).toBe(false)
  admission.dispose()
  expect(streams.every((stream) => stream.destroyed)).toBe(true)
  expect(accepted.destroyed).toBe(true)
})
it('framing rate limits apply across local and forwarded commands', () => {
  const dispatch = vi.fn(
      () => new Promise<ReturnType<typeof agentOutput>>(() => undefined),
    ),
    admission = new AgentStreamAdmission(dispatch),
    streams = []
  for (let index = 0; index < AGENT_LIMITS.requestsPerSecond + 1; index++) {
    const stream = new PassThrough()
    streams.push(stream)
    admission.accept(
      stream,
      index % 2
        ? {
            origin: 'ssh-forward',
            host: asHostId('ssh'),
            generation: 'object:1',
            current: () => undefined,
          }
        : { origin: 'application-local' },
    )
    stream.write(
      JSON.stringify({ contract: '1.0', argv: ['workspaces'], defaults: {}, stdin: '' }) +
        '\n',
    )
  }
  expect(dispatch).toHaveBeenCalledTimes(AGENT_LIMITS.requestsPerSecond)
  expect(streams.at(-1)?.destroyed).toBe(true)
  admission.dispose()
})
