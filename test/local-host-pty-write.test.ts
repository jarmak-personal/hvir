import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import type { PtyWriteData, PtyExit } from '../src/main/project-host/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'

const supervisors: PtySupervisor[] = []
const mocks = vi.hoisted(() => ({ spawn: vi.fn<(...args: unknown[]) => unknown>() }))
vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
function transport() {
  const listeners = new Set<(data: string) => void>()
  const proc = {
    pid: 123,
    write: vi.fn<(data: string | Buffer) => void>(),
    resize: vi.fn(),
    kill: vi.fn(),
    onExit: (_listener: (exit: PtyExit) => void) => ({ dispose: () => undefined }),
    onData: (listener: (data: string) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
  mocks.spawn.mockReturnValue(proc)
  return { proc, listeners }
}
async function pty() {
  // Retain the sole spawn authority even at this immediate node-pty adapter seam.
  const supervisor = new PtySupervisor()
  supervisors.push(supervisor)
  const info = await supervisor.spawn({
    host: new LocalHost(),
    provider: plainShellProvider,
    launchSpec: { file: '/bin/sh', args: [] },
    cwd: localPath('/tmp/pty-write-fixture'),
    ownerId: 1234,
  })
  return {
    write: (data: PtyWriteData) => supervisor.write(info.id, 1234, data),
    writeConfirmed: (data: PtyWriteData) =>
      supervisor.writeConfirmed(info.id, 1234, data),
    onData: (onData: (data: string) => void) =>
      supervisor.attach(info.id, 1234, { onData }),
  }
}
afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.disposeAll()
})
beforeEach(() => vi.clearAllMocks())
describe('LocalHost PTY write adapter', () => {
  it.each(['write', 'writeConfirmed'] as const)(
    'copies exact byte views at the %s boundary',
    async (method) => {
      const { proc } = transport()
      const process = await pty()
      const source = Uint8Array.of(99, 0, 128, 255, 77)
      const view = source.subarray(1, 4)
      const written = process[method](view)
      source.fill(42)
      await written
      expect(proc.write).toHaveBeenCalledExactlyOnceWith(Buffer.from([0, 128, 255]))
      expect(Buffer.isBuffer(proc.write.mock.calls[0]![0])).toBe(true)
    },
  )
  it('preserves string writes and decoded output subscriptions', async () => {
    const { proc, listeners } = transport()
    const process = await pty()
    process.write('existing text é🙂')
    await process.writeConfirmed('provider atomic frame')
    expect(proc.write.mock.calls).toEqual([
      ['existing text é🙂'],
      ['provider atomic frame'],
    ])
    const output = vi.fn()
    const dispose = process.onData(output)
    for (const listener of listeners) listener('decoded output é🙂')
    expect(output).toHaveBeenCalledExactlyOnceWith('decoded output é🙂')
    await dispose()
    expect(listeners.size).toBe(1)
    for (const listener of listeners) listener('detached output')
    expect(output).toHaveBeenCalledOnce()
  })
})
