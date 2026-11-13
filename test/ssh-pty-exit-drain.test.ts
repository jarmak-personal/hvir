import { EventEmitter, once } from 'node:events'
import { Readable } from 'node:stream'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import type { PtyPreparedTerminal } from '../src/main/pty/pty-contract'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { createSshPtyProcess } from '../src/main/project-host/ssh-pty-process'
import { hostPath } from '../src/shared/host-path'
import { createTestSshHost } from './ssh-host-test-fixture'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

/** The real Node readable side models ssh2's buffered data/end ordering. Only
 * remote protocol messages and outgoing write acknowledgements are controlled. */
class ReadChannel extends Readable {
  readonly stderr = new EventEmitter()
  readonly setWindow = vi.fn()
  readonly writes: Buffer[] = []
  writeFailure?: Error
  holdWrites = false
  private readonly writeCallbacks: Array<(error?: Error | null) => void> = []
  private remoteEnded = false
  private remoteClosed = false
  private closing = false
  constructor() {
    super({ autoDestroy: false })
  }
  override _read(): void {}
  readonly write = vi.fn(
    (value: string | Uint8Array, callback?: (error?: Error | null) => void): boolean => {
      this.writes.push(Buffer.from(value))
      if (callback) {
        if (this.holdWrites) this.writeCallbacks.push(callback)
        else callback(this.writeFailure)
      }
      return true
    },
  )
  readonly close = vi.fn(() => this.remoteClose())
  remoteData(bytes: Buffer): void {
    this.push(bytes)
  }
  remoteExit(code: number): void {
    this.emit('exit', code)
  }
  remoteEOF(): void {
    if (this.remoteEnded) return
    this.remoteEnded = true
    this.push(null)
  }
  remoteClose(): void {
    if (this.closing) return
    this.closing = true
    const close = () => {
      if (this.remoteClosed) return
      this.remoteClosed = true
      this.emit('close')
    }
    if (this.readableEnded) close()
    else this.once('end', close)
    this.remoteEOF()
  }
  releaseWrites(): void {
    for (const callback of this.writeCallbacks.splice(0)) callback()
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture() {
  const channels: ReadChannel[] = []
  const clients: Array<EventEmitter & { channels: ReadChannel[] }> = []
  let holdOpen = false
  let opening: ((channel: ReadChannel) => void) | undefined
  let pendingOpen: (() => void) | undefined
  const host = createTestSshHost({
    config: {
      alias: 'tail-fixture',
      hostname: 'tail.invalid',
      user: 'test',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
    clientFactory: () => {
      const client = Object.assign(new EventEmitter(), {
        channels: [] as ReadChannel[],
        connect: () => queueMicrotask(() => client.emit('ready')),
        exec: (
          _command: string,
          _options: object,
          callback: (error: undefined, channel: ClientChannel) => void,
        ) => {
          const channel = new ReadChannel()
          channels.push(channel)
          client.channels.push(channel)
          const open = () => {
            callback(undefined, channel as unknown as ClientChannel)
            opening?.(channel)
          }
          if (holdOpen) pendingOpen = open
          else open()
        },
        end: () => client.emit('close'),
        destroy: () => client.emit('close'),
      })
      clients.push(client)
      return client as unknown as Client
    },
  })
  const probe = vi
    .spyOn(host, 'exec')
    .mockResolvedValue({ code: 1, signal: null, stdout: '', stderr: '' })
  await host.connect()
  probe.mockRestore()
  vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
  const supervisor = new PtySupervisor()
  let writer: Parameters<PtyPreparedTerminal['connect']>[0] | undefined
  const nativeOutput: string[] = []
  const pending = new Set<ReturnType<typeof deferred>>()
  let gate: ReturnType<typeof deferred> | undefined
  let emitReply = false
  const prepared = {
    columns: 80,
    rows: 24,
    connect: (value) => {
      writer = value
    },
    output: vi.fn(async (text: string) => {
      if (gate) await gate.promise
      nativeOutput.push(text)
      if (emitReply) await writer!.writeReply(Uint8Array.of(0x1b, 0xff, 0x80))
    }),
    exited: vi.fn(() => Promise.resolve()),
    failed: vi.fn(),
    dispose: vi.fn(() => Promise.resolve()),
  } satisfies PtyPreparedTerminal
  const decoded: string[] = []
  const exits = vi.fn()
  supervisor.onExit(exits)
  const start = async (signal?: AbortSignal) => {
    const managed = await supervisor.spawn({
      signal,
      host,
      provider: plainShellProvider,
      ownerId: 71,
      sessionId: 'tail',
      cwd: hostPath(host.hostId, '/test-project'),
      prepareTerminal: () => Promise.resolve(prepared),
    })
    supervisor.attach(managed.id, 71, { onData: (text) => decoded.push(text) })
    return managed
  }
  const pauseConsumer = () => {
    gate = deferred()
    pending.add(gate)
    return gate
  }
  cleanups.push(async () => {
    for (const item of pending) item.resolve()
    for (const channel of channels) {
      channel.releaseWrites()
      channel.resume()
      channel.remoteClose()
    }
    await supervisor.disposeAllAndWait()
    await host.dispose()
  })
  return {
    host,
    supervisor,
    channels,
    prepared,
    nativeOutput,
    decoded,
    exits,
    start,
    pauseConsumer,
    reply: () => writer!,
    enableReplies: () => {
      emitReply = true
    },
    holdOpen: () => {
      holdOpen = true
    },
    duringOpen: (callback: (channel: ReadChannel) => void) => {
      opening = callback
    },
    releaseOpen: () => {
      pendingOpen?.()
    },
    disconnect: () => {
      const client = clients.find((candidate) => candidate.channels.length)
      if (!client) throw new Error('terminal transport missing')
      client.emit('close')
      // ssh2's channel-manager cleanup runs after the client close event.
      for (const channel of client.channels) channel.remoteClose()
    },
  }
}

describe('SSH PTY drained exit through SshHost and supervisor', () => {
  it('retains status and unread data emitted immediately after the SSH open callback', async () => {
    const f = await fixture()
    f.enableReplies()
    f.duringOpen((channel) => {
      channel.remoteData(Buffer.from('opening decoded tail é🙂'))
      channel.remoteExit(13)
      channel.remoteClose()
    })
    await f.start()
    await vi.waitFor(() =>
      expect(f.prepared.exited).toHaveBeenCalledExactlyOnceWith({
        exitCode: 13,
        signal: undefined,
      }),
    )
    expect(f.nativeOutput.join('')).toBe('opening decoded tail é🙂')
    expect(f.decoded.join('')).toBe('opening decoded tail é🙂')
    expect(f.prepared.failed).not.toHaveBeenCalled()
    expect(f.channels[0]?.writes).toEqual([])
  })

  it('retains paused final output after exit status until readable close and native drain', async () => {
    const f = await fixture()
    await f.start()
    const channel = f.channels[0]!
    const gate = f.pauseConsumer()
    channel.remoteData(Buffer.from('prefix'))
    await vi.waitFor(() => expect(f.prepared.output).toHaveBeenCalledTimes(1))
    expect(channel.isPaused()).toBe(true)
    channel.remoteExit(7)
    channel.remoteData(Buffer.from(' final é🙂'))
    channel.remoteClose()
    expect(f.reply().live).toBe(false)
    expect(f.exits).not.toHaveBeenCalled()
    expect(f.supervisor.get('tail')).toBeDefined()
    gate.resolve()
    await vi.waitFor(() =>
      expect(f.prepared.exited).toHaveBeenCalledExactlyOnceWith({
        exitCode: 7,
        signal: undefined,
      }),
    )
    expect(f.decoded.join('')).toBe('prefix final é🙂')
    expect(f.nativeOutput.join('')).toBe('prefix final é🙂')
    expect(f.prepared.failed).not.toHaveBeenCalled()
    expect(f.exits).toHaveBeenCalledOnce()
  })

  it('keeps EOF-only input open, then preserves an exit status received after EOF', async () => {
    const f = await fixture()
    await f.start()
    const channel = f.channels[0]!
    channel.remoteData(Buffer.from('completed output'))
    channel.remoteEOF()
    await vi.waitFor(() => expect(channel.readableEnded).toBe(true))
    expect(f.reply().live).toBe(true)
    await f.reply().writeReply(Uint8Array.of(0xff, 0x80))
    expect(channel.writes).toEqual([Buffer.from([0xff, 0x80])])
    expect(f.exits).not.toHaveBeenCalled()
    channel.remoteExit(23)
    channel.remoteClose()
    await vi.waitFor(() =>
      expect(f.prepared.exited).toHaveBeenCalledExactlyOnceWith({
        exitCode: 23,
        signal: undefined,
      }),
    )
    expect(f.nativeOutput.join('')).toBe('completed output')
  })

  it('flushes the UTF-8 decoder exactly once and uses 255 only when no status exists', async () => {
    const f = await fixture()
    await f.start()
    const channel = f.channels[0]!
    channel.remoteData(Buffer.from([0x41, 0xe2]))
    channel.remoteData(Buffer.from([0x82]))
    channel.remoteClose()
    await vi.waitFor(() =>
      expect(f.prepared.exited).toHaveBeenCalledExactlyOnceWith({
        exitCode: 255,
        signal: undefined,
      }),
    )
    expect(f.nativeOutput.join('')).toBe('A\ufffd')
    channel.emit('end')
    channel.emit('close')
    expect(f.nativeOutput.join('')).toBe('A\ufffd')
    expect(f.exits).toHaveBeenCalledOnce()
    for (const event of ['data', 'end', 'exit'])
      expect(channel.listenerCount(event)).toBe(0)
  })

  it('drains already buffered data after transport disconnect without forcing resume', async () => {
    const f = await fixture()
    await f.start()
    const channel = f.channels[0]!
    const gate = f.pauseConsumer()
    channel.remoteData(Buffer.from('before disconnect'))
    await vi.waitFor(() => expect(f.prepared.output).toHaveBeenCalledOnce())
    channel.remoteData(Buffer.from(' buffered tail'))
    f.disconnect()
    expect(channel.isPaused()).toBe(true)
    expect(f.reply().live).toBe(false)
    expect(f.exits).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() =>
      expect(f.prepared.exited).toHaveBeenCalledExactlyOnceWith({
        exitCode: 255,
        signal: undefined,
      }),
    )
    expect(f.nativeOutput.join('')).toBe('before disconnect buffered tail')
    expect(f.prepared.failed).not.toHaveBeenCalled()
  })

  it('discards native replies after physical exit while retaining final parser output', async () => {
    const f = await fixture()
    await f.start()
    f.enableReplies()
    const channel = f.channels[0]!
    const gate = f.pauseConsumer()
    channel.remoteData(Buffer.from('report request'))
    await vi.waitFor(() => expect(f.prepared.output).toHaveBeenCalledOnce())
    channel.remoteExit(0)
    channel.remoteData(Buffer.from(' last report'))
    channel.remoteClose()
    gate.resolve()
    await vi.waitFor(() => expect(f.prepared.exited).toHaveBeenCalledOnce())
    expect(channel.writes).toEqual([])
    expect(f.nativeOutput.join('')).toBe('report request last report')
    expect(f.prepared.failed).not.toHaveBeenCalled()
  })

  it('keeps a genuine live reply-write failure explicit', async () => {
    const f = await fixture()
    await f.start()
    f.enableReplies()
    const channel = f.channels[0]!
    channel.writeFailure = new Error('live write refused')
    channel.remoteData(Buffer.from('query'))
    await vi.waitFor(() => expect(f.prepared.failed).toHaveBeenCalledOnce())
    expect(f.prepared.failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'live write refused' }),
    )
    expect(f.reply().live).toBe(true)
    expect(f.supervisor.get('tail')).toBeDefined()
  })

  it('settles a pending reply write when physical exit closes input without failing the parser tail', async () => {
    const f = await fixture()
    await f.start()
    f.enableReplies()
    const channel = f.channels[0]!
    channel.holdWrites = true
    channel.remoteData(Buffer.from('query before exit'))
    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledOnce())
    channel.remoteExit(0)
    channel.remoteData(Buffer.from(' queued final'))
    channel.remoteClose()
    await vi.waitFor(() => expect(f.prepared.exited).toHaveBeenCalledOnce())
    expect(f.nativeOutput.join('')).toBe('query before exit queued final')
    expect(f.prepared.failed).not.toHaveBeenCalled()
    channel.releaseWrites()
    expect(f.prepared.exited).toHaveBeenCalledOnce()
  })

  it('explicit close revokes input and settles scoped native ownership once', async () => {
    const f = await fixture()
    await f.start()
    const channel = f.channels[0]!
    const gate = f.pauseConsumer()
    channel.remoteData(Buffer.from('owned output'))
    await vi.waitFor(() => expect(f.prepared.output).toHaveBeenCalledOnce())
    f.supervisor.disposeSession('tail', 71)
    expect(f.reply().live).toBe(false)
    gate.resolve()
    await f.supervisor.disposeAllAndWait()
    await vi.waitFor(() => expect(f.prepared.dispose).toHaveBeenCalledOnce())
    expect(channel.close).toHaveBeenCalled()
    expect(f.supervisor.list()).toEqual([])
    expect(f.prepared.failed).not.toHaveBeenCalled()
  })

  it('cancels a late physical spawn without publishing a session or leaving the channel owned', async () => {
    const f = await fixture()
    f.holdOpen()
    const controller = new AbortController()
    const spawning = f.start(controller.signal)
    const rejected = expect(spawning).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(f.channels).toHaveLength(1))
    controller.abort()
    f.releaseOpen()
    await rejected
    expect(f.supervisor.list()).toEqual([])
    await vi.waitFor(() => expect(f.prepared.dispose).toHaveBeenCalledOnce())
    expect(f.channels[0]?.close).toHaveBeenCalled()
  })
})

describe('SSH PTY adapter partial initialization', () => {
  it('handles synchronous transport failure and caches the final exit for late subscribers', async () => {
    const channel = new ReadChannel()
    const stop = vi.fn()
    const process = createSshPtyProcess(channel as unknown as ClientChannel, -1)
    process.bindTransportFailure((fail) => {
      fail()
      return stop
    })
    expect(process.inputClosed).toBe(true)
    const output: string[] = []
    process.onData((text) => output.push(text))
    const early = vi.fn()
    process.onExit(early)
    channel.remoteData(Buffer.from('received before failure cleanup'))
    channel.remoteClose()
    await vi.waitFor(() =>
      expect(early).toHaveBeenCalledExactlyOnceWith({ exitCode: 255, signal: undefined }),
    )
    const late = vi.fn()
    process.onExit(late)
    expect(late).toHaveBeenCalledExactlyOnceWith({ exitCode: 255, signal: undefined })
    expect(output).toEqual(['received before failure cleanup'])
    expect(stop).toHaveBeenCalledOnce()
  })

  it('does not consume readable data before the first PTY output subscriber exists', async () => {
    const channel = new ReadChannel()
    const process = createSshPtyProcess(channel as unknown as ClientChannel, -1)
    channel.remoteData(Buffer.from('unread opening data'))
    channel.remoteExit(6)
    channel.remoteClose()
    expect(channel.readableLength).toBe(Buffer.byteLength('unread opening data'))
    const order: string[] = []
    process.onExit((exit) => order.push(`exit:${exit.exitCode}`))
    process.onData((text) => order.push(text))
    await vi.waitFor(() => expect(order).toEqual(['unread opening data', 'exit:6']))
  })

  it('settles an already closed channel without acquiring an unnecessary failure registration', async () => {
    const channel = new ReadChannel()
    const closed = once(channel, 'close')
    channel.destroy()
    await closed
    expect(channel.closed).toBe(true)
    const stop = vi.fn()
    const register = vi.fn((fail: () => void) => {
      fail()
      return stop
    })
    const process = createSshPtyProcess(channel as unknown as ClientChannel, -1)
    process.bindTransportFailure(register)
    const exit = vi.fn()
    process.onExit(exit)
    expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 255, signal: undefined })
    expect(register).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    for (const event of ['data', 'end', 'exit', 'close'])
      expect(channel.listenerCount(event)).toBe(0)
  })

  it('releases a newly acquired failure registration when it synchronously closes the channel', async () => {
    const channel = new ReadChannel()
    const process = createSshPtyProcess(channel as unknown as ClientChannel, -1)
    const ended = once(channel, 'end')
    channel.remoteEOF()
    channel.resume()
    await ended
    expect(process.inputClosed).toBe(false)
    const stop = vi.fn()
    process.bindTransportFailure((fail) => {
      fail()
      channel.remoteClose()
      return stop
    })
    const exit = vi.fn()
    process.onExit(exit)
    expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 255, signal: undefined })
    expect(stop).toHaveBeenCalledOnce()
    expect(() => process.bindTransportFailure(() => vi.fn())).toThrow('already bound')
    expect(stop).toHaveBeenCalledOnce()
    for (const event of ['data', 'end', 'exit', 'close'])
      expect(channel.listenerCount(event)).toBe(0)
  })
})
