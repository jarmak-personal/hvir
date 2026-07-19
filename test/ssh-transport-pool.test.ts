import { EventEmitter } from 'node:events'

import type {
  AnyAuthMethod,
  Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
} from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import type { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import {
  SSH_CONTROL_CHANNEL_BUDGET,
  SSH_MAX_KEYBOARD_INTERACTIVE_ROUNDS,
  SSH_MAX_PHYSICAL_TRANSPORTS,
  SSH_TERMINAL_CHANNEL_BUDGET,
  SSH_TRANSPORT_IDLE_GRACE_MS,
  SshHost,
  type SshPrompt,
} from '../src/main/project-host'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { hostPath } from '../src/shared'

const OWNER_ID = 71

describe('SshHost transport pool', () => {
  it('keeps 12 PTYs live across terminal transports while control exec remains available', async () => {
    const fixture = await poolFixture()
    const { host, supervisor, clients } = fixture
    const exits = vi.fn()
    supervisor.onExit(exits)

    await spawnShells(fixture, 12)

    expect(host.transportDiagnostics()).toEqual([
      expect.objectContaining({ role: 'control', primary: true, channels: 0 }),
      expect.objectContaining({
        role: 'terminal',
        channels: SSH_TERMINAL_CHANNEL_BUDGET,
      }),
      expect.objectContaining({ role: 'terminal', channels: 4 }),
    ])
    await expect(host.exec('git', ['status'])).resolves.toMatchObject({ code: 0 })

    clients[1]?.emit('close')
    expect(exits).toHaveBeenCalledTimes(SSH_TERMINAL_CHANNEL_BUDGET)
    expect(supervisor.list()).toHaveLength(4)
    expect(host.connectionState).toBe('connected')

    await host.dispose()
    supervisor.disposeAll()
  })

  it('grows a second control transport without borrowing terminal capacity', async () => {
    const fixture = await poolFixture()
    const streams = Array.from({ length: SSH_CONTROL_CHANNEL_BUDGET + 1 }, () =>
      fixture.host.execStream('cat', [], { keepStdinOpen: true }),
    )

    await vi.waitFor(() =>
      expect(fixture.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ role: 'control', channels: 6 }),
        expect.objectContaining({ role: 'control', channels: 1 }),
      ]),
    )
    expect(fixture.clients).toHaveLength(2)

    for (const stream of streams) stream.dispose()
    await fixture.host.dispose()
  })

  it('accounts for the shared SFTP subsystem as a control session channel', async () => {
    const fixture = await poolFixture()
    const session = await hostFiles(fixture.host).getSftp()

    expect(fixture.host.transportDiagnostics()).toEqual([
      expect.objectContaining({ role: 'control', channels: 1 }),
    ])
    session.emit('close')
    expect(fixture.host.transportDiagnostics()).toEqual([
      expect.objectContaining({ role: 'control', channels: 0 }),
    ])

    await fixture.host.dispose()
  })

  it('reuses an idle terminal transport and retires it after five minutes', async () => {
    vi.useFakeTimers()
    try {
      const fixture = await poolFixture()
      await spawnShells(fixture, 1, 0)
      const terminalClient = fixture.clients[1]
      if (!terminalClient) throw new Error('Expected a terminal transport')
      fixture.supervisor.kill('shell-0', OWNER_ID)

      await vi.advanceTimersByTimeAsync(SSH_TRANSPORT_IDLE_GRACE_MS - 1)
      expect(terminalClient.end).not.toHaveBeenCalled()
      await spawnShells(fixture, 1, 1)
      expect(fixture.clients).toHaveLength(2)

      fixture.supervisor.kill('shell-1', OWNER_ID)
      await vi.advanceTimersByTimeAsync(SSH_TRANSPORT_IDLE_GRACE_MS)
      expect(terminalClient.end).toHaveBeenCalledOnce()
      expect(fixture.host.transportDiagnostics()).toEqual([
        expect.objectContaining({ role: 'control', primary: true }),
      ])
      await fixture.host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports the documented PTY floor and fails calmly at the physical cap', async () => {
    const fixture = await poolFixture()
    const controlStreams = Array.from({ length: SSH_CONTROL_CHANNEL_BUDGET + 1 }, () =>
      fixture.host.execStream('cat', [], { keepStdinOpen: true }),
    )
    await vi.waitFor(() =>
      expect(
        fixture.host
          .transportDiagnostics()
          .filter((transport) => transport.role === 'control'),
      ).toHaveLength(2),
    )
    const terminalCapacity =
      (SSH_MAX_PHYSICAL_TRANSPORTS - 2) * SSH_TERMINAL_CHANNEL_BUDGET

    await spawnShells(fixture, terminalCapacity)
    expect(fixture.host.transportDiagnostics()).toHaveLength(SSH_MAX_PHYSICAL_TRANSPORTS)
    await expect(spawnShells(fixture, 1, terminalCapacity)).rejects.toThrow(
      /capacity is full.*existing sessions remain connected/i,
    )
    expect(fixture.supervisor.list()).toHaveLength(terminalCapacity)
    fixture.supervisor.kill('shell-0', OWNER_ID)
    await expect(spawnShells(fixture, 1, terminalCapacity + 1)).resolves.toBeUndefined()
    expect(fixture.supervisor.list()).toHaveLength(terminalCapacity)

    fixture.supervisor.disposeSessions()
    for (const stream of controlStreams) stream.dispose()
    await fixture.host.dispose()
  })

  it('spills to a healthy terminal transport after a channel-open refusal', async () => {
    const clients: PoolClient[] = []
    const factory = vi.fn(() => {
      const client = poolClient({ channelOpenFailures: clients.length === 1 ? 2 : 0 })
      clients.push(client)
      return client as unknown as Client
    })
    const fixture = await poolFixture(factory, clients)

    await spawnShells(fixture, 1)

    expect(clients).toHaveLength(3)
    expect(fixture.host.transportDiagnostics()).toEqual([
      expect.objectContaining({ role: 'control' }),
      expect.objectContaining({ role: 'terminal', channelBudget: 8, refusedChannels: 2 }),
      expect.objectContaining({ role: 'terminal', channels: 1 }),
    ])

    await spawnShells(fixture, 1, 1)
    expect(clients).toHaveLength(3)
    expect(fixture.host.transportDiagnostics()).toEqual([
      expect.objectContaining({ role: 'control' }),
      expect.objectContaining({ role: 'terminal', channelBudget: 8, channels: 1 }),
      expect.objectContaining({ role: 'terminal', channels: 1 }),
    ])
    await fixture.host.dispose()
    fixture.supervisor.disposeAll()
  })

  it('cancels PTY channel-refusal backoff during disconnect', async () => {
    const clients: PoolClient[] = []
    let reportRefusal!: () => void
    const refused = new Promise<void>((resolve) => {
      reportRefusal = resolve
    })
    const factory = vi.fn(() => {
      const client = poolClient({
        channelOpenFailures: clients.length === 1 ? 1 : 0,
        onChannelOpenFailure: reportRefusal,
      })
      clients.push(client)
      return client as unknown as Client
    })
    const fixture = await poolFixture(factory, clients)
    const spawning = spawnShells(fixture, 1)
    await refused
    const rejected = expect(spawning).rejects.toMatchObject({ name: 'AbortError' })

    await fixture.host.dispose()

    await rejected
    fixture.supervisor.disposeAll()
  })

  it('cancels pending serialized pool growth during disconnect', async () => {
    const clients: PoolClient[] = []
    const factory = vi.fn(() => {
      const client = poolClient()
      if (clients.length === 1) client.connect.mockImplementation(() => undefined)
      clients.push(client)
      return client as unknown as Client
    })
    const fixture = await poolFixture(factory, clients)
    const spawning = spawnShells(fixture, 1)
    await vi.waitFor(() => expect(clients).toHaveLength(2))
    const rejected = expect(spawning).rejects.toThrow(/closed before authentication/i)

    await fixture.host.dispose()

    await rejected
    expect(fixture.host.connectionState).toBe('disconnected')
    expect(clients[1]?.end).toHaveBeenCalledOnce()
  })

  it('keeps existing PTYs alive and recovers after a physical connection refusal', async () => {
    const clients: PoolClient[] = []
    const factory = vi.fn(() => {
      const client = poolClient()
      if (clients.length === 2) {
        client.connect.mockImplementation(() =>
          queueMicrotask(() => client.emit('close')),
        )
      }
      clients.push(client)
      return client as unknown as Client
    })
    const fixture = await poolFixture(factory, clients)
    await spawnShells(fixture, SSH_TERMINAL_CHANNEL_BUDGET)

    await expect(spawnShells(fixture, 1, SSH_TERMINAL_CHANNEL_BUDGET)).rejects.toThrow(
      /capacity could not grow; existing sessions remain connected/i,
    )
    expect(fixture.supervisor.list()).toHaveLength(SSH_TERMINAL_CHANNEL_BUDGET)
    expect(fixture.host.connectionState).toBe('connected')

    await expect(
      spawnShells(fixture, 1, SSH_TERMINAL_CHANNEL_BUDGET + 1),
    ).resolves.toBeUndefined()
    expect(fixture.supervisor.list()).toHaveLength(SSH_TERMINAL_CHANNEL_BUDGET + 1)
    fixture.supervisor.disposeAll()
    await fixture.host.dispose()
  })
})

describe('SshHost pooled authentication bounds', () => {
  it('reuses a password in memory for pool growth without another prompt', async () => {
    const prompt = vi.fn(() => Promise.resolve(['secret']))
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })

    const credentialAttempt: TestCredentialAttempt = { passphrases: new Map() }
    expect(
      await nextAuth(connectConfig(host, 'primary', credentialAttempt), ['password']),
    ).toMatchObject({
      type: 'password',
      password: 'secret',
    })
    ;(
      host as unknown as {
        rememberSuccessfulCredentials(value: TestCredentialAttempt): void
      }
    ).rememberSuccessfulCredentials(credentialAttempt)
    expect(await nextAuth(connectConfig(host, 'pool'), ['password'])).toMatchObject({
      type: 'password',
      password: 'secret',
    })
    expect(prompt).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('does not reuse a credential from an authentication attempt that never became ready', async () => {
    const prompt = vi
      .fn<() => Promise<readonly string[] | undefined>>()
      .mockResolvedValueOnce(['wrong'])
      .mockResolvedValueOnce(['right'])
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })

    expect(await nextAuth(connectConfig(host), ['password'])).toMatchObject({
      password: 'wrong',
    })
    expect(await nextAuth(connectConfig(host), ['password'])).toMatchObject({
      password: 'right',
    })
    expect(prompt).toHaveBeenCalledTimes(2)
    await host.dispose()
  })

  it('terminates adversarial keyboard-interactive challenge loops', async () => {
    const prompt = vi.fn<(request: SshPrompt) => Promise<readonly string[] | undefined>>(
      () => Promise.resolve(['answer']),
    )
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })
    const auth = await nextAuth(connectConfig(host, 'pool'), ['keyboard-interactive'])
    if (!auth || auth.type !== 'keyboard-interactive') {
      throw new Error('Expected keyboard-interactive authentication')
    }

    const answers: string[][] = []
    for (let round = 0; round < SSH_MAX_KEYBOARD_INTERACTIVE_ROUNDS + 1; round++) {
      answers.push(
        await new Promise<string[]>((resolve) =>
          auth.prompt(
            `round ${round}`,
            `instructions ${round}`,
            '',
            [{ prompt: `code ${round}`, echo: false }],
            resolve,
          ),
        ),
      )
    }

    expect(prompt).toHaveBeenCalledTimes(SSH_MAX_KEYBOARD_INTERACTIVE_ROUNDS)
    expect(prompt.mock.calls[0]?.[0].title).toMatch(/^Additional SSH capacity/)
    expect(answers.at(-1)).toEqual([])
    await host.dispose()
  })

  it('attempts each offered authentication method once despite method oscillation', async () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(['secret']) },
    })
    const config = connectConfig(host, 'pool')

    expect(await nextAuth(config, ['password'])).toMatchObject({ type: 'password' })
    expect(await nextAuth(config, ['password', 'keyboard-interactive'])).toMatchObject({
      type: 'keyboard-interactive',
    })
    await expect(nextAuth(config, ['password'])).resolves.toBe(false)
    expect(config.readyTimeout).toBe(120_000)
    await host.dispose()
  })

  it('ignores a late credential answer after cancellation', async () => {
    let answer!: (value: readonly string[] | undefined) => void
    const prompt = vi.fn(
      () =>
        new Promise<readonly string[] | undefined>((resolve) => {
          answer = resolve
        }),
    )
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })
    const authentication = nextAuth(connectConfig(host, 'pool'), ['password'])
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())

    await host.dispose()
    answer(['too late'])

    await expect(authentication).resolves.toBe(false)
  })

  it('does not retry pool growth after a prompted authentication cancellation', async () => {
    const clients: PoolClient[] = []
    const prompt = vi.fn(() => Promise.resolve(undefined))
    const factory = vi.fn(() => {
      const client = poolClient()
      if (clients.length === 1) {
        client.connect.mockImplementation((config: ConnectConfig) => {
          const handler = config.authHandler as unknown as (
            methods: readonly string[],
            partial: boolean,
            next: (method: AnyAuthMethod | false) => void,
          ) => void
          handler(['password'], false, () => client.emit('close'))
        })
      }
      clients.push(client)
      return client as unknown as Client
    })
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
      clientFactory: factory,
    })
    const probe = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })
    await host.connect()
    probe.mockRestore()
    vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
    const fixture = { host, supervisor: new PtySupervisor(), clients }

    await expect(spawnShells(fixture, 1)).rejects.toThrow(/capacity could not grow/i)
    await expect(spawnShells(fixture, 1, 1)).rejects.toThrow(
      /after authentication was cancelled or refused/i,
    )
    expect(prompt).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    await host.dispose()
  })

  it('allows promptless pool growth after a successful primary reconnect', async () => {
    const clients: PoolClient[] = []
    const prompt = vi.fn(() => Promise.resolve(undefined))
    const factory = vi.fn(() => {
      const client = poolClient()
      if (clients.length === 1) {
        client.connect.mockImplementation((config: ConnectConfig) => {
          const handler = config.authHandler as unknown as (
            methods: readonly string[],
            partial: boolean,
            next: (method: AnyAuthMethod | false) => void,
          ) => void
          handler(['password'], false, () => client.emit('close'))
        })
      }
      clients.push(client)
      return client as unknown as Client
    })
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
      clientFactory: factory,
    })
    const probe = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })
    await host.connect()
    probe.mockRestore()
    vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
    const fixture = { host, supervisor: new PtySupervisor(), clients }

    await expect(spawnShells(fixture, 1)).rejects.toThrow(/capacity could not grow/i)
    clients[0]?.emit('close')
    await host.connect()
    await expect(spawnShells(fixture, 1, 1)).resolves.toBeUndefined()

    expect(prompt).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(4)
    fixture.supervisor.disposeAll()
    await host.dispose()
  })
})

interface PoolClient extends EventEmitter {
  readonly connect: ReturnType<typeof vi.fn>
  readonly exec: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
  readonly channels: ClientChannel[]
  readonly sessions: SFTPWrapper[]
}

interface PoolFixture {
  readonly host: SshHost
  readonly supervisor: PtySupervisor
  readonly clients: PoolClient[]
}

async function poolFixture(
  suppliedFactory?: () => Client,
  suppliedClients?: PoolClient[],
): Promise<PoolFixture> {
  const clients = suppliedClients ?? []
  const factory =
    suppliedFactory ??
    (() => {
      const client = poolClient()
      clients.push(client)
      return client as unknown as Client
    })
  const host = new SshHost({
    config: aliasConfig(),
    prompter: { prompt: () => Promise.resolve(undefined) },
    clientFactory: factory,
  })
  const probe = vi.spyOn(host, 'exec').mockResolvedValue({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
  })
  await host.connect()
  probe.mockRestore()
  vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
  return { host, supervisor: new PtySupervisor(), clients }
}

async function spawnShells(
  fixture: PoolFixture,
  count: number,
  start = 0,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, offset) =>
      fixture.supervisor.spawn({
        host: fixture.host,
        provider: plainShellProvider,
        cwd: hostPath(fixture.host.hostId, '/project'),
        ownerId: OWNER_ID,
        sessionId: `shell-${start + offset}`,
      }),
    ),
  )
}

function poolClient(
  options: { channelOpenFailures?: number; onChannelOpenFailure?: () => void } = {},
): PoolClient {
  let remainingFailures = options.channelOpenFailures ?? 0
  const channels: ClientChannel[] = []
  const sessions: SFTPWrapper[] = []
  const client = Object.assign(new EventEmitter(), {
    channels,
    sessions,
    connect: vi.fn(() => queueMicrotask(() => client.emit('ready'))),
    exec: vi.fn(
      (
        _command: string,
        optionsOrCallback:
          | Record<string, unknown>
          | ((error: Error | undefined, channel?: ClientChannel) => void),
        maybeCallback?: (error: Error | undefined, channel?: ClientChannel) => void,
      ) => {
        const callback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        if (!callback) throw new Error('Expected SSH exec callback')
        if (remainingFailures > 0) {
          remainingFailures--
          options.onChannelOpenFailure?.()
          callback(new Error('(SSH) Channel open failure: open failed'))
          return
        }
        const channel = poolChannel()
        channels.push(channel)
        callback(undefined, channel)
      },
    ),
    sftp: vi.fn((callback: (error: Error | undefined, session?: SFTPWrapper) => void) => {
      const session = Object.assign(new EventEmitter(), {
        end: vi.fn(() => session.emit('close')),
      }) as unknown as SFTPWrapper
      sessions.push(session)
      callback(undefined, session)
    }),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
  })
  return client
}

function poolChannel(): ClientChannel {
  const stderr = new EventEmitter()
  let closed = false
  const channel = Object.assign(new EventEmitter(), {
    stderr,
    write: vi.fn((_value: string, callback?: () => void) => {
      callback?.()
      return true
    }),
    end: vi.fn((_value?: string, callback?: () => void) => {
      callback?.()
      if (closed) return
      closed = true
      channel.emit('exit', 0)
      channel.emit('close')
    }),
    close: vi.fn(() => {
      if (closed) return
      closed = true
      channel.emit('close')
    }),
    setWindow: vi.fn(),
  })
  return channel as unknown as ClientChannel
}

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}

function connectConfig(
  host: SshHost,
  purpose: 'primary' | 'pool' = 'primary',
  credentialAttempt?: TestCredentialAttempt,
): ConnectConfig {
  return (
    host as unknown as {
      connectConfig(
        value?: 'primary' | 'pool',
        markPrompt?: () => void,
        isActive?: () => boolean,
        attempt?: TestCredentialAttempt,
      ): ConnectConfig
    }
  ).connectConfig(purpose, undefined, undefined, credentialAttempt)
}

function hostFiles(host: SshHost): SshFileAccess {
  return (host as unknown as { files: SshFileAccess }).files
}

interface TestCredentialAttempt {
  password?: string
  readonly passphrases: Map<string, string>
}

function nextAuth(
  config: ConnectConfig,
  methods: readonly string[] | null,
): Promise<AnyAuthMethod | false> {
  const handler = config.authHandler as unknown as (
    methods: readonly string[] | null,
    partial: boolean | null,
    next: (method: AnyAuthMethod | false) => void,
  ) => void
  return new Promise((resolve) =>
    handler(methods, methods === null ? null : false, resolve),
  )
}
