import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import { NativeTerminalEffectPolicy } from '../src/main/terminal/native-terminal-effect-policy'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import { localPath } from '../src/shared/host-path'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
import type { PtyExit } from '../src/main/project-host/project-host'
import type { NativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
const supervisors: PtySupervisor[] = []
afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.disposeAll()
})
describe('local physical exit versus retained effect authority', () => {
  it('keeps parsing and the single effect drain while the public input-closed capability suppresses tail writes', async () => {
    const source = new Set<(data: string) => void>()
    const exits = new Set<(exit: PtyExit) => void>()
    const proc = {
      pid: 4321,
      inputClosed: false,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: (listener: (data: string) => void) => {
        source.add(listener)
        return { dispose: () => source.delete(listener) }
      },
      onExit: vi.fn((listener: (exit: PtyExit) => void) => {
        exits.add(listener)
        return { dispose: () => exits.delete(listener) }
      }),
    }
    mocks.spawn.mockReturnValueOnce(proc)
    let sequence = 0
    const clipboard = { writeText: vi.fn() },
      publish = vi.fn()
    const codec = {
      prepare: vi.fn(() => Promise.resolve('native-handle')),
      inspectProducer: vi.fn(() =>
        Promise.resolve({
          ...nativeTerminalStatus(),
          appliedSequence: sequence,
          ioAppliedSequence: sequence,
        }),
      ),
      resizeProducer: vi.fn(() => Promise.resolve(nativeTerminalStatus())),
      feed: vi.fn(() => {
        sequence++
        return Promise.resolve()
      }),
      drainReplies: vi.fn(() => Promise.resolve(Uint8Array.of(27, 91, 48, 110))),
      drainEffectsProducer: vi.fn<() => Promise<NativeTerminalEffectBatch>>(() =>
        Promise.resolve({
          effects: [
            {
              kind: 'title',
              title: sequence === 1 ? 'live title' : 'finished title',
              sequence,
              eventSerial: sequence * 4 - 3,
            },
            { kind: 'bell', sequence, eventSerial: sequence * 4 - 2 },
            {
              kind: 'notification',
              source: 'osc-9',
              title: '',
              body: '',
              sequence,
              eventSerial: sequence * 4 - 1,
            },
            {
              kind: 'clipboard',
              protocol: 'osc-52',
              selection: 'c',
              data: 'YQ==',
              sequence,
              eventSerial: sequence * 4,
            },
          ],
          droppedEffects: 0,
          semanticGeneration: 0,
        }),
      ),
      end: vi.fn(() => Promise.resolve()),
    }
    const sessions = new NativeTerminalSessions(
      codec,
      () => true,
      undefined,
      new NativeTerminalEffectPolicy(clipboard, publish),
    )
    const supervisor = new PtySupervisor()
    supervisors.push(supervisor)
    const managed = await supervisor.spawn({
      host: new LocalHost(),
      provider: plainShellProvider,
      launchSpec: { file: '/bin/sh', args: [] },
      cwd: localPath('/tmp/native-effect-fixture'),
      ownerId: 1,
      prepareTerminal: (reservation, signal) =>
        sessions.prepare(reservation, signal, { width: 32, height: 32, backingScale: 1 }),
    })
    for (const listener of source) listener('live output')
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    expect(proc.write).toHaveBeenCalledExactlyOnceWith(Buffer.from([27, 91, 48, 110]))
    expect(publish).toHaveBeenCalledTimes(3)
    publish.mockClear()
    clipboard.writeText.mockClear()
    proc.write.mockClear()
    proc.inputClosed = true // Public physical fact precedes the independently retained readable tail.
    for (const listener of source) listener('retained tail')
    await vi.waitFor(() => expect(codec.drainEffectsProducer).toHaveBeenCalledTimes(2))
    expect(codec.feed).toHaveBeenCalledTimes(2)
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: managed.id, instanceId: managed.instanceId }),
      {
        id: managed.id,
        instanceId: managed.instanceId,
        eventSerial: 5,
        effect: { kind: 'title', title: 'finished title' },
      },
    )
    expect(proc.write).not.toHaveBeenCalled()
    expect(sessions.get(managed.id)?.title).toEqual({
      title: 'finished title',
      eventSerial: 5,
    })
    expect(sessions.get(managed.id)).toMatchObject({
      readonly: false,
      inputClosed: true,
      unavailable: false,
    })
    expect(supervisor.get(managed.id)?.instanceId).toBe(managed.instanceId)
    for (const listener of exits) listener({ exitCode: 0, signal: undefined })
    await vi.waitFor(() => expect(sessions.get(managed.id)?.readonly).toBe(true))
    expect(sessions.get(managed.id)?.title).toEqual({
      title: 'finished title',
      eventSerial: 5,
    })
  })
})
