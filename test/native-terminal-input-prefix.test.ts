import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalProcess } from '../src/main/terminal/native-terminal-process'
import { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import {
  PtyTerminalOutput,
  PtyTerminalOutputBudget,
} from '../src/main/pty/pty-terminal-output'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
import { localPath } from '../src/shared/host-path'
import {
  NativeTerminalAdmissionError,
  type NativeTerminalCommand,
} from '../src/shared/native-terminal'

const boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  createEndpoint: vi.fn(),
  closeEndpoint: vi.fn(),
}))
vi.mock('electron', () => ({}))
vi.mock('../src/main/worker-host', () => ({
  spawnUtilityWorker: boundary.spawn,
  workerPath: (name: string) => `/worker/${name}`,
}))
vi.mock('@hvir/native-terminal/resource', () => ({
  default: {
    createEndpoint: boundary.createEndpoint,
    closeEndpoint: boundary.closeEndpoint,
  },
}))
interface Request {
  kind: 'request'
  epoch: string
  id: number
  command: NativeTerminalCommand
}
class Child extends EventEmitter {
  readonly messages: unknown[] = []
  readonly pid = 20001
  readonly kill = vi.fn(() => {
    this.emit('exit', 0)
    return true
  })
  postMessage(message: unknown): void {
    this.messages.push(structuredClone(message))
  }
  requests(): Request[] {
    return this.messages.filter((message): message is Request =>
      Boolean(
        message &&
        typeof message === 'object' &&
        'kind' in message &&
        message.kind === 'request',
      ),
    )
  }
}
const owners: NativeTerminalProcess[] = []
const outputs: PtyTerminalOutput[] = []
const key = {
  kind: 'key' as const,
  key: 22,
  modifiers: 2,
  consumedModifiers: 0,
  action: 1 as const,
  text: 'c',
  unshiftedCodepoint: 99,
  composing: false,
  optionAsAlt: false,
}
const input = (state = '1'): NativeTerminalCommand => ({
  kind: 'input',
  state,
  input: key,
  readOnly: false,
})
const result = {
  bytes: Uint8Array.of(3),
  capacity: 1,
  source: 'user',
  requestedMutation: 1,
}
function ownedProcess() {
  const process = new NativeTerminalProcess('/trusted/libghostty')
  owners.push(process)
  return process
}
function watched<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined)
  return promise
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}
function reply(child: Child, request: Request, value: unknown) {
  child.emit('message', {
    kind: 'result',
    epoch: request.epoch,
    id: request.id,
    ok: true,
    value,
  })
}
function request(child: Child, kind: NativeTerminalCommand['kind']): Request {
  const found = child
    .requests()
    .filter((item) => item.command.kind === kind)
    .at(-1)
  expect(found).toBeDefined()
  return found!
}
async function appliedIo(child: Child, sequence: number): Promise<void> {
  const progress = request(child, 'producer-inspect')
  reply(child, progress, {
    ...nativeTerminalStatus(),
    appliedSequence: sequence,
    ioAppliedSequence: sequence,
  })
  await flush()
}
async function ready(process: NativeTerminalProcess): Promise<Child> {
  await flush()
  const child = boundary.spawn.mock.results.at(-1)!.value as Child
  child.emit('spawn')
  child.emit('message', { kind: 'ready', epoch: process.epoch, pid: child.pid })
  await flush()
  return child
}
/** Real main/ingress owners; only the external utility/resource/PTY transport is fake.
 * Reply bytes are fixtures, not evidence of a native encoder or mode implementation. */
async function ingress() {
  const process = ownedProcess()
  const host: NativeTerminalHost = new NativeTerminalHost(process, {
    resolve: (id) => sessions.resolve(id),
    isRendererCurrent: () => true,
  })
  const sessions: NativeTerminalSessions = new NativeTerminalSessions(host, () => true)
  const reservation = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: localPath('/project'),
  }
  const preparing = watched(
    sessions.prepare(reservation, new AbortController().signal, {
      width: 32,
      height: 32,
      backingScale: 1,
    }),
  )
  const child = await ready(process)
  reply(child, request(child, 'create'), {
    state: '1',
    status: { ...nativeTerminalStatus(), ioAppliedMutation: 0, inputFailure: 0 },
  })
  await flush()
  reply(child, request(child, 'inspect'), {
    ...nativeTerminalStatus(),
    ioAppliedMutation: 0,
    inputFailure: 0,
  })
  const prepared = await preparing
  const source = { pause: vi.fn(), resume: vi.fn() }
  const budget = new PtyTerminalOutputBudget()
  const output = new PtyTerminalOutput(source, prepared, budget)
  outputs.push(output)
  const parsed = vi.fn((bytes: number) => output.parsed(bytes))
  const writeReply = vi.fn<(_bytes: Uint8Array) => Promise<void>>(() => Promise.resolve())
  const repliesDispatched = vi.fn((bytes: number) => output.repliesDispatched(bytes))
  prepared.connect({ live: true, writeReply, parsed, repliesDispatched })
  const handle = sessions.get('session')!.handle
  return {
    process,
    child,
    host,
    sessions,
    output,
    source,
    parsed,
    handle,
    budget,
    writeReply,
    repliesDispatched,
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  boundary.createEndpoint.mockResolvedValue({})
  boundary.closeEndpoint.mockResolvedValue(undefined)
  boundary.spawn.mockImplementation(() => new Child())
})
afterEach(async () => {
  for (const process of owners.splice(0)) process.dispose()
  await flush()
  await Promise.all(outputs.splice(0).map((output) => output.dispose()))
  vi.useRealTimers()
})

describe('native process admission around actual parsed-prefix eligibility', () => {
  it.each(['state', 'aggregate'] as const)(
    'keeps prerequisite producer housekeeping and cleanup moving at the %s bound',
    async (bound) => {
      const f = await ingress()
      // One already-admitted 20KiB prefix takes two native feed acknowledgements.
      f.output.output('x'.repeat(20 * 1024))
      await flush()
      const first = request(f.child, 'feed')
      const eligible = vi.fn(f.output.capturePrefix().parsed)
      const waiting = watched(f.host.input(f.handle, 'instance', key, eligible))
      const controls = bound === 'state' ? 5 : 30
      for (let index = 0; index < controls; index++) {
        const state = bound === 'state' ? '1' : String(Math.floor(index / 5) + 1)
        void watched(f.process.request({ kind: 'inspect', state }))
      }
      if (bound === 'aggregate') {
        for (let state = 2; state <= 32; state++)
          void watched(
            f.process.request({
              kind: 'feed',
              state: String(state),
              sequence: 1,
              bytes: Uint8Array.of(120),
            }),
          )
      }
      await flush()
      expect(eligible).toHaveBeenCalledTimes(1)
      expect(
        f.child.requests().filter((item) => item.command.kind === 'input'),
      ).toHaveLength(0)
      await expect(
        f.process.request({ kind: 'inspect', state: '1' }),
      ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
      if (bound === 'aggregate')
        await expect(
          f.process.request({ kind: 'inspect', state: '32' }),
        ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
      const cleanup = watched(
        f.process.request({ kind: 'release', state: '1', lease: '99' }),
      )
      await flush()
      const release = request(f.child, 'release')
      // Six ordinary state controls + producer + cleanup already consume all eight.
      await expect(
        f.process.request({ kind: 'destroy', state: '1' }),
      ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
      if (bound === 'aggregate')
        await expect(
          f.process.request({ kind: 'release', state: '32', lease: '88' }),
        ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
      reply(f.child, first, { result: 0 })
      await flush()
      expect(f.parsed).toHaveBeenCalledExactlyOnceWith(16 * 1024)
      expect(
        f.child.requests().filter((item) => item.command.kind === 'input'),
      ).toHaveLength(0)
      const firstProgress = request(f.child, 'producer-inspect')
      reply(f.child, firstProgress, {
        ...nativeTerminalStatus(),
        appliedSequence: 1,
        ioAppliedSequence: 0,
      })
      await flush()
      expect(
        f.child.requests().filter((item) => item.command.kind === 'drain'),
      ).toHaveLength(0)
      expect(f.repliesDispatched).not.toHaveBeenCalled()
      await expect(
        f.process.request({ kind: 'inspect', state: '1' }),
      ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
      await vi.advanceTimersByTimeAsync(1)
      const nextProgress = request(f.child, 'producer-inspect')
      expect(nextProgress.id).not.toBe(firstProgress.id)
      expect(
        f.child.requests().filter((item) => item.command.kind === 'producer-inspect'),
      ).toHaveLength(2)
      await appliedIo(f.child, 1)
      const drain = request(f.child, 'drain')
      expect(drain.id).toBeGreaterThan(first.id)
      reply(f.child, drain, new Uint8Array())
      await flush()
      const discard = request(f.child, 'effects')
      reply(f.child, discard, {
        result: 0,
        effects: [],
        droppedEffects: 0,
        semanticGeneration: 0,
      })
      await flush()
      const second = request(f.child, 'feed')
      expect(second.command).toMatchObject({ state: '1', sequence: 2 })
      expect(
        f.child.requests().filter((item) => item.command.kind === 'input'),
      ).toHaveLength(0)
      reply(f.child, second, { result: 0 })
      await flush()
      expect(f.parsed.mock.calls).toEqual([[16 * 1024], [4 * 1024]])
      const sentInput = request(f.child, 'input')
      // Parsing, not final reply/effect drain or GPU presentation, makes input eligible.
      expect(f.output.queuedBytes).toBe(20 * 1024)
      expect(f.source.resume).not.toHaveBeenCalled()
      await appliedIo(f.child, 2)
      const lastDrain = request(f.child, 'drain')
      expect(lastDrain.id).not.toBe(drain.id)
      reply(f.child, sentInput, result)
      await expect(waiting).resolves.toEqual(result)
      reply(f.child, lastDrain, new Uint8Array())
      await flush()
      reply(f.child, request(f.child, 'effects'), {
        result: 0,
        effects: [],
        droppedEffects: 0,
        semanticGeneration: 0,
      })
      reply(f.child, release, { result: 0 })
      await cleanup
      await flush()
      expect(f.output.queuedBytes).toBe(0)
      expect(f.source.resume).toHaveBeenCalledTimes(1)
      expect(f.sessions.get('session')).toMatchObject({ unavailable: false })
      expect(f.process.available).toBe(true)
    },
  )

  it('does not extend a captured prefix to later continuing source output', async () => {
    const f = await ingress()
    f.output.output('first')
    await flush()
    const first = request(f.child, 'feed')
    const waiting = watched(
      f.host.input(f.handle, 'instance', key, f.output.capturePrefix().parsed),
    )
    f.output.output('later')
    await flush()
    expect(
      f.child.requests().filter((item) => item.command.kind === 'input'),
    ).toHaveLength(0)
    reply(f.child, first, { result: 0 })
    await flush()
    const sent = request(f.child, 'input')
    expect(f.parsed.mock.calls).toEqual([[5]])
    expect(f.output.queuedBytes).toBe(10)
    expect(
      f.child.requests().filter((item) => item.command.kind === 'feed'),
    ).toHaveLength(1)
    reply(f.child, sent, result)
    await expect(waiting).resolves.toEqual(result)
    await appliedIo(f.child, 1)
    reply(f.child, request(f.child, 'drain'), new Uint8Array())
    await flush()
    reply(f.child, request(f.child, 'effects'), {
      result: 0,
      effects: [],
      droppedEffects: 0,
      semanticGeneration: 0,
    })
    await flush()
    const later = request(f.child, 'feed')
    expect(later.command).toMatchObject({
      state: '1',
      sequence: 2,
      bytes: new TextEncoder().encode('later'),
    })
  })

  it('waits for a distinct pending source batch admitted before capture, excluding its later continuation', async () => {
    const f = await ingress()
    f.output.output('first')
    await flush()
    const first = request(f.child, 'feed')
    f.output.output('p'.repeat(16 * 1024)) // pending source admission, not a slice of the active batch
    const waiting = watched(
      f.host.input(f.handle, 'instance', key, f.output.capturePrefix().parsed),
    )
    f.output.output('later'.repeat(800))
    await flush()
    reply(f.child, first, { result: 0 })
    await flush()
    expect(f.parsed.mock.calls).toEqual([[5]])
    expect(
      f.child.requests().filter((item) => item.command.kind === 'input'),
    ).toHaveLength(0)
    await appliedIo(f.child, 1)
    reply(f.child, request(f.child, 'drain'), new Uint8Array())
    await flush()
    reply(f.child, request(f.child, 'effects'), {
      result: 0,
      effects: [],
      droppedEffects: 0,
      semanticGeneration: 0,
    })
    await flush()
    const pending = request(f.child, 'feed')
    expect(pending.command).toMatchObject({
      state: '1',
      sequence: 2,
      bytes: new TextEncoder().encode('p'.repeat(16 * 1024)),
    })
    expect(
      f.child.requests().filter((item) => item.command.kind === 'input'),
    ).toHaveLength(0)
    reply(f.child, pending, { result: 0 })
    await flush()
    expect(f.parsed.mock.calls).toEqual([[5], [16 * 1024]])
    expect(
      f.child.requests().filter((item) => item.command.kind === 'feed'),
    ).toHaveLength(2)
    expect(f.output.queuedBytes).toBe(16 * 1024 + 4000)
    reply(f.child, request(f.child, 'input'), result)
    await expect(waiting).resolves.toEqual(result)
    expect(f.source.resume).not.toHaveBeenCalled()
  })

  it('keeps parsed and reply prefixes separate until IO applied and the captured writer is invoked', async () => {
    const f = await ingress()
    let confirm!: () => void
    let confirmed = false
    f.writeReply.mockReturnValue(
      new Promise<void>((resolve) => {
        confirm = () => {
          confirmed = true
          resolve()
        }
      }),
    )
    f.output.output('\x1b[5n')
    const prefix = f.output.capturePrefix()
    const abort = new AbortController()
    let parsedReady = false,
      repliesReady = false
    const parsed = watched(
      prefix.parsed(abort.signal).then(() => {
        parsedReady = true
      }),
    )
    const replies = watched(
      prefix.replies(abort.signal).then(() => {
        repliesReady = true
      }),
    )
    await flush()
    reply(f.child, request(f.child, 'feed'), { result: 0 })
    await flush()
    await parsed
    expect(parsedReady).toBe(true)
    expect(repliesReady).toBe(false)
    expect(f.writeReply).not.toHaveBeenCalled()
    const progress = request(f.child, 'producer-inspect')
    reply(f.child, progress, {
      ...nativeTerminalStatus(),
      appliedSequence: 1,
      ioAppliedSequence: 0,
    })
    await flush()
    expect(
      f.child.requests().filter((item) => item.command.kind === 'drain'),
    ).toHaveLength(0)
    expect(repliesReady).toBe(false)
    // While IO completion is pending, cleanup remains admitted independently.
    const cleanup = watched(
      f.process.request({ kind: 'release', state: '1', lease: '100' }),
    )
    await flush()
    reply(f.child, request(f.child, 'release'), { result: 0 })
    await cleanup
    await vi.advanceTimersByTimeAsync(1)
    await appliedIo(f.child, 1)
    const nativeReply = Uint8Array.of(27, 91, 48, 110)
    expect(repliesReady).toBe(false)
    reply(f.child, request(f.child, 'drain'), nativeReply)
    await flush()
    await replies
    expect(f.writeReply).toHaveBeenCalledExactlyOnceWith(nativeReply)
    expect(f.repliesDispatched).toHaveBeenCalledExactlyOnceWith(4)
    expect(repliesReady).toBe(true)
    expect(confirmed).toBe(false)
    expect(f.output.queuedBytes).toBe(4)
    reply(f.child, request(f.child, 'effects'), {
      result: 0,
      effects: [],
      droppedEffects: 0,
      semanticGeneration: 0,
    })
    await flush()
    expect(f.output.queuedBytes).toBe(4)
    expect(f.source.resume).not.toHaveBeenCalled()
    confirm()
    await flush()
    expect(f.output.queuedBytes).toBe(0)
    expect(f.source.resume).toHaveBeenCalledTimes(1)
    expect(
      f.child.requests().filter((item) => item.command.kind === 'feed'),
    ).toHaveLength(1)
    expect(f.sessions.get('session')).toMatchObject({ unavailable: false })
  })

  it('cancels an unsent eligibility wait without posting input and returns only its reserved credit', async () => {
    const f = await ingress()
    f.output.output('pending')
    await flush()
    const cancel = new AbortController()
    const eligible = vi.fn(f.output.capturePrefix().parsed)
    const waiting = watched(f.process.request(input(), cancel.signal, eligible))
    for (let i = 0; i < 5; i++)
      void watched(f.process.request({ kind: 'inspect', state: '1' }))
    await flush()
    expect(eligible).toHaveBeenCalledTimes(1)
    await expect(
      f.process.request({ kind: 'inspect', state: '1' }),
    ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
    cancel.abort()
    await expect(waiting).rejects.toThrow('cancelled')
    expect(eligible.mock.calls[0]![0].aborted).toBe(true)
    void watched(f.process.request({ kind: 'inspect', state: '1' }))
    await flush()
    expect(
      f.child.requests().filter((item) => item.command.kind === 'input'),
    ).toHaveLength(0)
    expect(
      f.child.messages.filter(
        (item) =>
          item && typeof item === 'object' && 'kind' in item && item.kind === 'cancel',
      ),
    ).toHaveLength(0)
    expect(f.output.queuedBytes).toBe(Buffer.byteLength('pending'))
  })

  it('retains the physical slot after an eligible posted input is logically aborted', async () => {
    const process = ownedProcess()
    const cancel = new AbortController()
    const waiting = watched(
      process.request(input(), cancel.signal, () => Promise.resolve()),
    )
    const child = await ready(process)
    const sent = request(child, 'input')
    for (let i = 0; i < 5; i++)
      void watched(process.request({ kind: 'inspect', state: '1' }))
    await flush()
    cancel.abort()
    await expect(waiting).rejects.toThrow('cancelled')
    await expect(process.request({ kind: 'inspect', state: '1' })).rejects.toBeInstanceOf(
      NativeTerminalAdmissionError,
    )
    expect(child.messages).toContainEqual({
      kind: 'cancel',
      epoch: process.epoch,
      id: sent.id,
    })
    reply(child, sent, result)
    await flush()
    void watched(process.request({ kind: 'inspect', state: '1' }))
    await flush()
    expect(process.available).toBe(true)
  })

  it.each(['close', 'loss'] as const)(
    'rejects and aborts the captured gate on process %s',
    async (action) => {
      const f = await ingress()
      f.output.output('pending')
      await flush()
      const eligible = vi.fn(f.output.capturePrefix().parsed)
      const waiting = watched(f.process.request(input(), undefined, eligible))
      await flush()
      if (action === 'close') f.process.dispose()
      else f.child.emit('exit', 1)
      await expect(waiting).rejects.toThrow(
        action === 'close' ? 'native-host-closed' : 'native-host-lost',
      )
      expect(eligible.mock.calls[0]![0].aborted).toBe(true)
      expect(
        f.child.requests().filter((item) => item.command.kind === 'input'),
      ).toHaveLength(0)
      expect(f.process.available).toBe(false)
    },
  )
})
