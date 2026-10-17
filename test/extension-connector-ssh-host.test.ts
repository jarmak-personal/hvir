import { EventEmitter } from 'node:events'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { createTestSshHost } from './ssh-host-test-fixture'
import { FINITE_EXEC_HOST_LIMIT } from '../src/main/project-host/finite-exec-admission'
import { SshTransportPool } from '../src/main/project-host/ssh-transport-pool'

/** Actual SshHost methods over fake SSH2 channels, without credentials or a claimed real server. */
function fixture(maxConcurrentExecs = 4) {
  const owner = connectorFixture('workspace')
  let mode: 'success' | 'truncated' | 'hanging' | 'closed' | 'empty' = 'success'
  let ordinaryHanging = false
  const channels: ReturnType<typeof channel>[] = []
  const commands: string[] = []
  const sftp = Object.assign(new EventEmitter(), {
    realpath: vi.fn((path: string, done: (error: undefined, value: string) => void) =>
      done(undefined, path),
    ),
    lstat: vi.fn((_path: string, done: (error: undefined, value: object) => void) =>
      done(undefined, { mode: 0o100755, size: 1, mtime: 0 }),
    ),
    end: vi.fn(() => sftp.emit('close')),
  })
  const client = Object.assign(new EventEmitter(), {
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
    sftp: vi.fn((done: (error: undefined, value: SFTPWrapper) => void) =>
      done(undefined, sftp as unknown as SFTPWrapper),
    ),
    exec: vi.fn((command: string, done: (error: undefined, value: unknown) => void) => {
      commands.push(command)
      const stream = channel(
        command,
        command.includes("'/installed/tool'")
          ? mode
          : ordinaryHanging
            ? 'hanging'
            : 'success',
      )
      channels.push(stream)
      done(undefined, stream)
    }),
  })
  const host = createTestSshHost({
    config: {
      alias: 'remote',
      hostname: 'example.test',
      user: 'test',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
    maxConcurrentExecs,
  })
  const internals = host as unknown as { state: 'connected'; client: Client }
  internals.state = 'connected'
  internals.client = client as unknown as Client
  owner.host.realpath.mockImplementation((path) => host.realpath(path))
  owner.host.stat.mockImplementation((path) => host.stat(path))
  owner.finiteExec.tryExec.mockImplementation((command, args, opts) =>
    host.finiteExec.tryExec(command, args, opts)!,
  )
  return {
    owner,
    host,
    channels,
    commands,
    client,
    mode: (value: typeof mode) => {
      mode = value
    },
    holdOrdinary: () => {
      ordinaryHanging = true
    },
    dispose: async () => {
      owner.dispose()
      for (const stream of channels) stream.emit('close')
      await host.dispose()
    },
  }
}
function channel(
  command: string,
  mode: 'success' | 'truncated' | 'hanging' | 'closed' | 'empty',
) {
  const stream = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    deferredClose: false,
    close: vi.fn(() => {
      if (!stream.deferredClose) stream.emit('close')
    }),
    end: vi.fn(() => {
      if (mode === 'hanging') return
      if (mode === 'closed') {
        stream.emit('close')
        return
      }
      if (mode === 'truncated') {
        stream.emit('data', Buffer.from('x'.repeat(65536)))
        return
      }
      if (mode !== 'empty') {
        const emoji = Buffer.from('😀')
        stream.emit('data', emoji.subarray(0, 2))
        stream.emit('data', emoji.subarray(2))
      }
      const marker = command.match(/__hvir_exec_status_[0-9a-f-]+__/)?.[0]
      if (!marker) throw new Error('Expected actual buffered SSH status wrapper')
      stream.stderr.emit(
        'data',
        Buffer.from((mode === 'empty' ? '' : 'diagnostic') + marker + '0'),
      )
      stream.emit('close')
    }),
  })
  return stream
}

describe('approved connectors through the actual SSH adapter', () => {
  it('retains late-channel admission across transport replacement and errors until actual close', async () => {
    const client = new EventEmitter() as Client
    const pool = new SshTransportPool({
      connected: () => Promise.resolve(client),
      lifecycleSignal: () => new AbortController().signal,
      assertTransportGrowthAllowed: () => undefined,
      openAuxiliaryTransport: () => Promise.reject(new Error('No transport growth')),
    })
    pool.registerPrimary(client)
    const opened: Array<(stream: ClientChannel) => void> = []
    const late = Array.from({ length: 4 }, () => {
      const stream = channel('', 'hanging')
      stream.deferredClose = true
      return stream
    })
    const pending = late.map(() => {
      const admitted = pool.tryOpenFiniteChannel(
        () =>
          new Promise<ClientChannel>((resolve) => {
            opened.push(resolve)
          }),
      )
      expect(admitted).toBeDefined()
      return admitted!
    })
    const outcomes = Promise.allSettled(pending)
    await Promise.resolve()
    expect(opened).toHaveLength(4)
    pool.dispose()
    pool.registerPrimary(new EventEmitter() as Client)
    opened.forEach((resolve, index) => resolve(late[index]! as unknown as ClientChannel))
    await vi.waitFor(() =>
      expect(late.every((stream) => stream.close.mock.calls.length === 1)).toBe(true),
    )
    expect(() => late[0]!.emit('error', new Error('late stream error'))).not.toThrow()
    expect(
      pool.tryOpenFiniteChannel(() => Promise.reject(new Error('Must not dispatch'))),
    ).toBeUndefined()
    expect(late.every((stream) => stream.end.mock.calls.length === 0)).toBe(true)
    late[0]!.emit('close')
    const replacement = channel('', 'hanging')
    const admitted = pool.tryOpenFiniteChannel(() =>
      Promise.resolve(replacement as unknown as ClientChannel),
    )
    expect(admitted).toBeDefined()
    await admitted
    replacement.close()
    for (const stream of late.slice(1)) stream.emit('close')
    expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true)
    expect(late.every((stream) => stream.listenerCount('error') === 0)).toBe(true)
    pool.dispose()
  })
  it.each([
    ['empty', 1],
    ['success', 14],
  ] as const)(
    'does not charge private status metadata against %s output at byte limit %i',
    async (mode, outputBytes) => {
      const f = fixture()
      try {
        Object.assign(f.owner.activation.revision.manifest.connectors![0]!, {
          outputBytes,
        })
        await f.owner.approve()
        f.mode(mode)
        expect(
          await f.owner.execution.execute(f.owner.caller, f.owner.input),
        ).toMatchObject({
          outcome: 'completed',
          code: 0,
          truncated: false,
          stdoutBytes: mode === 'empty' ? 0 : 4,
          stderrBytes: mode === 'empty' ? 0 : 10,
        })
      } finally {
        await f.dispose()
      }
    },
  )
  it('still clips actual tool output one byte beyond the declared limit', async () => {
    const f = fixture()
    try {
      Object.assign(f.owner.activation.revision.manifest.connectors![0]!, {
        outputBytes: 13,
      })
      await f.owner.approve()
      f.mode('success')
      expect(
        await f.owner.execution.execute(f.owner.caller, f.owner.input),
      ).toMatchObject({
        outcome: 'interrupted-uncertain',
        code: 0,
        truncated: true,
        stdoutBytes: 4,
        stderrBytes: 9,
      })
    } finally {
      await f.dispose()
    }
  })
  it('drains a late channel returned after its transport retired before exposing or ending it', async () => {
    const f = fixture()
    try {
      await f.owner.approve()
      let opened!: (error: undefined, value: unknown) => void
      f.client.exec.mockImplementationOnce((_command, done) => {
        opened = done
      })
      const pending = f.owner.execution.execute(f.owner.caller, f.owner.input)
      await vi.waitFor(() => expect(opened).toBeDefined())
      f.owner.execution.dispose()
      const interrupted = await pending
      expect(interrupted.outcome).toBe('interrupted-uncertain')
      expect(interrupted.receipt).toBeUndefined()
      await f.host.dispose()
      const late = channel('', 'hanging')
      late.deferredClose = true
      opened(undefined, late)
      await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce())
      expect(late.end).not.toHaveBeenCalled()
      expect(f.host.transportDiagnostics()).toEqual([])
      const underlying = f.owner.finiteExec.tryExec.mock.results[0]!
        .value as Promise<unknown>
      let settled = false
      void underlying.finally(() => (settled = true)).catch(() => undefined)
      expect(() => late.emit('error', new Error('late stream failure'))).not.toThrow()
      expect(() => late.emit('error', new Error('another late failure'))).not.toThrow()
      await Promise.resolve()
      expect(settled).toBe(false)
      late.emit('close')
      await expect(underlying).rejects.toThrow('transport retired')
      expect(late.listenerCount('error')).toBe(0)
      expect(late.end).not.toHaveBeenCalled()
    } finally {
      await f.dispose()
    }
  })
  it('refuses saturated established control capacity before dispatch without transport-growth queueing', async () => {
    const f = fixture(16)
    try {
      await f.owner.approve()
      f.holdOrdinary()
      const pending = Array.from({ length: 5 }, () => f.host.exec('git', ['status']))
      await vi.waitFor(() => expect(f.commands).toHaveLength(5))
      expect(f.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ channels: 6, primary: true }),
      ])
      expect(
        await f.owner.execution.execute(f.owner.caller, f.owner.input),
      ).toMatchObject({ outcome: 'not-started', reason: 'capacity' })
      expect(f.commands).toHaveLength(5)
      for (const stream of f.channels) {
        stream.emit('exit', 0)
        stream.emit('close')
      }
      await Promise.all(pending)
    } finally {
      await f.dispose()
    }
  })
  it('preserves literal argv, declared environment, pinned workspace cwd, UTF-8 and recovered process status', async () => {
    const f = fixture()
    try {
      await f.owner.approve()
      const literal = "$(printf escaped); space and ' quote"
      const result = await f.owner.execution.execute(f.owner.caller, {
        ...f.owner.input,
        args: [literal],
      })
      expect(result).toMatchObject({
        host: 'remote',
        outcome: 'completed',
        code: 0,
        truncated: false,
      })
      expect(f.commands).toHaveLength(1)
      expect(f.commands[0]).toContain("cd -- '/workspace' && env TOOL_HOME='/library'")
      expect(f.commands[0]).toContain(
        "'/installed/tool' '--json' '$(printf escaped); space and '\"'\"' quote'",
      )
      expect(
        f.owner.execution.output(f.owner.caller, {
          receipt: result.receipt,
          stream: 'stdout',
          offset: 0,
        })?.data,
      ).toBe('😀')
      expect(
        f.owner.execution.output(f.owner.caller, {
          receipt: result.receipt,
          stream: 'stderr',
          offset: 0,
        })?.data,
      ).toBe('diagnostic')
      expect(f.owner.host.exec).not.toHaveBeenCalled()
    } finally {
      await f.dispose()
    }
  })
  it.each(['truncated', 'closed'] as const)(
    'reports %s channels as uncertain without a complete exit claim',
    async (mode) => {
      const f = fixture()
      try {
        Object.assign(f.owner.activation.revision.manifest.connectors![0]!, {
          outputBytes: 32,
        })
        await f.owner.approve()
        f.mode(mode)
        const result = await f.owner.execution.execute(f.owner.caller, f.owner.input)
        expect(result).toMatchObject({
          outcome: 'interrupted-uncertain',
          code: null,
          truncated: mode === 'truncated',
        })
        expect(result.stdoutBytes + result.stderrBytes).toBeLessThanOrEqual(32)
        expect(f.commands).toHaveLength(1)
      } finally {
        await f.dispose()
      }
    },
  )
  it.each([1, 16])(
    'keeps ordinary work usable beside four finite commands across installations (ordinary max %i)',
    async (max) => {
      const f = fixture(max)
      try {
        await f.owner.approve()
        const second = {
          ...f.owner.activation,
          installationId: 'second',
          generation: 'second',
        }
        f.owner.active.set('second', second)
        const prepared = await f.owner.approvals.prepare(
          {
            installationId: 'second',
            connector: 'tool',
            host: 'remote',
            executable: '/installed/tool',
            configuration: { args: [], env: {} },
          },
          () => undefined,
        )
        await f.owner.approvals.approve(prepared.token)
        const other = {
          ...f.owner.caller,
          activation: second,
          view: 'second',
          action: 'independent',
          current: () => undefined,
        }
        f.mode('hanging')
        const pending = [
          f.owner.execution.execute({ ...f.owner.caller, action: 'a' }, f.owner.input),
          f.owner.execution.execute({ ...f.owner.caller, action: 'b' }, f.owner.input),
          f.owner.execution.execute({ ...other, action: 'c' }, f.owner.input),
          f.owner.execution.execute({ ...other, action: 'd' }, f.owner.input),
        ]
        await vi.waitFor(() => expect(f.commands).toHaveLength(FINITE_EXEC_HOST_LIMIT))
        expect(f.host.transportDiagnostics()).toEqual([
          expect.objectContaining({ role: 'control', primary: true, channels: 5 }),
        ])
        expect(
          await f.owner.execution.execute({ ...other, action: 'excess' }, f.owner.input),
        ).toMatchObject({ outcome: 'not-started', reason: 'capacity' })
        expect(f.commands).toHaveLength(4)
        await expect(f.host.exec('git', ['status'])).resolves.toMatchObject({ code: 0 })
        expect(f.commands).toHaveLength(5)
        for (const stream of f.channels.slice(0, 4)) stream.deferredClose = true
        f.owner.controller.abort()
        expect(
          (await Promise.all(pending)).every(
            (result) => result.outcome === 'interrupted-uncertain',
          ),
        ).toBe(true)
        // Caller completion cannot release the physical host's finite reservations.
        expect(f.host.finiteExec.tryExec('/installed/tool', [])).toBeUndefined()
        await expect(f.host.exec('git', ['status'])).resolves.toMatchObject({ code: 0 })
        f.channels[0]!.emit('close')
        await vi.waitFor(() => expect(f.host.transportDiagnostics()[0]?.channels).toBe(4))
        f.mode('closed')
        await expect(
          f.host.finiteExec.tryExec('/installed/tool', []),
        ).resolves.toMatchObject({ code: null })
        expect(f.client.exec).toHaveBeenCalledTimes(7)
      } finally {
        await f.dispose()
      }
    },
  )
})
