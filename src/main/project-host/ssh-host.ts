import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import { Client, utils, type ClientChannel, type ConnectConfig } from 'ssh2'

import {
  asHostId,
  type DirEntry,
  type ExecResult,
  type HostConnectionState,
  type HostId,
  type HostPath,
  type HostWatchTier,
  type LoopbackEndpoint,
  type Stat,
  type WatchEvent,
} from '../../shared'
import type {
  Disposer,
  ExecOptions,
  ExecStreamHandle,
  ProjectHost,
  PtyProcess,
  ReadFileOptions,
  SpawnPtyOptions,
  WatchOptions,
  WriteFileOptions,
} from './project-host'
import { assertLoopbackEndpoint, MAX_EXEC_STREAM_WRITE_BYTES } from './project-host'
import type { SshAliasConfig } from './ssh-config'
import { SshFileAccess } from './ssh-file-access'
import {
  SshTransportPool,
  type SshTransportDiagnostic,
  type SshTransportRole,
} from './ssh-transport-pool'
import { SshWatchService } from './ssh-watch-service'

export {
  SSH_CONTROL_CHANNEL_BUDGET,
  SSH_MAX_CONTROL_TRANSPORTS,
  SSH_MAX_PHYSICAL_TRANSPORTS,
  SSH_TERMINAL_CHANNEL_BUDGET,
  SSH_TRANSPORT_IDLE_GRACE_MS,
  type SshTransportDiagnostic,
} from './ssh-transport-pool'

export interface SshIdentity {
  readonly path: string
  readonly privateKey: Buffer | string
}
export interface SshPrompt {
  readonly hostId: string
  readonly kind:
    'password' | 'passphrase' | 'keyboard-interactive' | 'host-key' | 'host-key-changed'
  readonly title: string
  readonly instructions?: string
  readonly fingerprint?: string
  readonly previousFingerprint?: string
  readonly prompts: readonly { readonly text: string; readonly echo: boolean }[]
}
export interface SshAuthPrompter {
  prompt(request: SshPrompt): Promise<readonly string[] | undefined>
}
export interface SshHostOptions {
  readonly config: SshAliasConfig
  readonly identities?: readonly SshIdentity[]
  readonly agentSocket?: string
  readonly prompter: SshAuthPrompter
  readonly pollIntervalMs?: number
  /** Slower snapshot safety net when inotify stays alive but emits no usable events. */
  readonly watchdogIntervalMs?: number
  /** Lightweight cache/tree refresh cadence, independent of recursive snapshots. */
  readonly refreshPulseIntervalMs?: number
  /** Idle delay between bounded recursive safety-scan cycles. */
  readonly slowScanIntervalMs?: number
  /** Maximum adaptive idle delay between unchanged safety-scan cycles. */
  readonly maxSlowScanIntervalMs?: number
  /** Maximum directories enumerated in one polling tick. */
  readonly pollDirectoryBatchSize?: number
  /** Local window for catching multiple writes hidden by SFTP's second-level mtime. */
  readonly fingerprintObservationWindowMs?: number
  /**
   * Maximum short-lived buffered exec channels. Long-lived PTY, watcher, and
   * telemetry channels plus SFTP share the control transport budget. The
   * default admits bounded parallel Git/filesystem reads while pool admission
   * still protects every transport's reserved capacity.
   */
  readonly maxConcurrentExecs?: number
  readonly trustedHostKey?: () => string | undefined
  readonly rememberHostKey?: (fingerprint: string) => Promise<void>
  /** Test seam for transport lifecycle races; production always constructs ssh2.Client. */
  readonly clientFactory?: () => Client
}

export const SSH_DEFAULT_MAX_CONCURRENT_EXECS = 4
export const SSH_MAX_KEYBOARD_INTERACTIVE_ROUNDS = 4

interface SshCredentialAttempt {
  password?: string
  readonly passphrases: Map<string, string>
}

let nextRemotePid = -1

export class SshHost implements ProjectHost {
  readonly hostId: HostId
  private state: HostConnectionState = 'disconnected'
  private tier: HostWatchTier = 'polling'
  private client?: Client
  private clientGeneration = 0
  private connecting?: Promise<void>
  private cancelConnecting?: (error: Error) => void
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectSuppressed = false
  private promptedDuringConnect = false
  private resolvedShell?: string
  private readonly listeners = new Set<(state: HostConnectionState) => void>()
  private readonly pendingClients = new Set<Client>()
  private promptTail: Promise<void> = Promise.resolve()
  private cachedPassword?: string
  private readonly cachedPassphrases = new Map<string, string>()
  private acceptedHostFingerprint?: string
  private poolGrowthPromptBlocked = false
  private lifecycleAbort = new AbortController()
  private readonly maxConcurrentExecs: number
  private activeExecs = 0
  private readonly execWaiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []
  private readonly transportPool: SshTransportPool
  private readonly files: SshFileAccess
  private readonly watches: SshWatchService
  constructor(private readonly options: SshHostOptions) {
    this.hostId = asHostId(options.config.alias)
    this.transportPool = new SshTransportPool({
      connected: () => this.connected(),
      assertTransportGrowthAllowed: (role) => this.assertTransportGrowthAllowed(role),
      openAuxiliaryTransport: (role) => this.openAuxiliaryTransport(role),
      lifecycleSignal: () => this.lifecycleAbort.signal,
    })
    this.files = new SshFileAccess(
      {
        hostId: this.hostId,
        openSftp: () => this.transportPool.openSftp(),
      },
      options,
    )
    this.watches = new SshWatchService(
      {
        hostId: this.hostId,
        connectionState: () => this.state,
        watchTier: () => this.tier,
        setWatchTier: (tier) => {
          this.tier = tier
          this.notifyState()
        },
        onConnectionState: (callback) => this.onConnectionState(callback),
        execStream: (command, args) => this.execStream(command, args),
      },
      this.files,
      options,
    )
    const requestedExecs = options.maxConcurrentExecs ?? SSH_DEFAULT_MAX_CONCURRENT_EXECS
    this.maxConcurrentExecs = Math.max(
      1,
      Math.min(
        16,
        Number.isFinite(requestedExecs)
          ? Math.floor(requestedExecs)
          : SSH_DEFAULT_MAX_CONCURRENT_EXECS,
      ),
    )
  }
  get connectionState(): HostConnectionState {
    return this.state
  }
  get watchTier(): HostWatchTier {
    return this.tier
  }
  transportDiagnostics(): readonly SshTransportDiagnostic[] {
    return this.transportPool.diagnostics()
  }
  onConnectionState(cb: (state: HostConnectionState) => void): Disposer {
    this.listeners.add(cb)
    cb(this.state)
    return () => {
      this.listeners.delete(cb)
    }
  }
  async connect(): Promise<void> {
    this.reconnectSuppressed = false
    return this.beginConnect()
  }
  private async beginConnect(): Promise<void> {
    if (this.state === 'connected') return
    if (this.connecting) return this.connecting
    this.disposed = false
    if (this.lifecycleAbort.signal.aborted) this.lifecycleAbort = new AbortController()
    this.setState(this.reconnectAttempt ? 'reconnecting' : 'connecting')
    this.connecting = this.open()
      .catch((error: unknown) => {
        this.setState(this.disposed ? 'disconnected' : 'failed')
        throw error
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifecycleAbort.abort()
    this.clientGeneration++
    this.cancelConnecting?.(new Error('SSH connection cancelled'))
    this.cancelConnecting = undefined
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectAttempt = 0
    for (const waiter of this.execWaiters.splice(0)) {
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
      waiter.reject(new Error('SSH connection cancelled'))
    }
    const clients = new Set<Client>([
      ...this.transportPool.dispose(),
      ...this.pendingClients,
    ])
    if (this.client) clients.add(this.client)
    this.pendingClients.clear()
    this.client = undefined
    this.files.dispose()
    this.resolvedShell = undefined
    this.cachedPassword = undefined
    this.cachedPassphrases.clear()
    this.acceptedHostFingerprint = undefined
    this.poolGrowthPromptBlocked = false
    this.setState('disconnected')
    await Promise.all([...clients].map((client) => closeSshClient(client)))
  }

  async defaultShell(): Promise<string> {
    if (this.resolvedShell) return this.resolvedShell
    const result = await this.exec('sh', [
      '-lc',
      'if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then printf "%s\\n" "$SHELL"; elif command -v bash >/dev/null 2>&1; then command -v bash; else printf "/bin/sh\\n"; fi',
    ])
    const candidate = result.stdout.trim().split(/\r?\n/).at(-1)
    this.resolvedShell =
      result.code === 0 && candidate?.startsWith('/') ? candidate : '/bin/sh'
    return this.resolvedShell
  }

  async exec(
    command: string,
    args: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const statusMarker = `__hvir_exec_status_${randomUUID()}__`
    // Connecting performs its own short capability probe through exec(). Do
    // not reserve a buffered slot until that handshake has completed.
    const release = await this.acquireExecSlot(opts.signal)
    try {
      const stream = await this.transportPool.openChannel(
        'control',
        (client) =>
          new Promise<ClientChannel>((resolve, reject) => {
            try {
              client.exec(
                remoteBufferedCommand(command, args, opts, statusMarker),
                (error, value) => (error ? reject(error) : resolve(value)),
              )
            } catch (error) {
              reject(asError(error))
            }
          }),
        opts.signal,
      )
      return await new Promise((resolve, reject) => {
        let stdout = '',
          stderr = '',
          bytes = 0,
          stdoutNulRecords = 0,
          code: number | null = null,
          signal: string | null = null
        let settled = false
        let truncated = false
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')
        const append = (kind: 'out' | 'err', chunk: Buffer): void => {
          if (truncated) return
          bytes += chunk.length
          if (kind === 'out' && opts.maxStdoutNulRecords !== undefined) {
            for (const byte of chunk) if (byte === 0) stdoutNulRecords++
          }
          if (kind === 'out') stdout += stdoutDecoder.write(chunk)
          else stderr += stderrDecoder.write(chunk)
          if (
            bytes > (opts.maxBuffer ?? 10 * 1024 * 1024) ||
            (opts.maxStdoutNulRecords !== undefined &&
              stdoutNulRecords >= opts.maxStdoutNulRecords)
          ) {
            if (opts.allowTruncatedOutput) {
              truncated = true
              return stream.close()
            }
            if (!settled) reject(new Error('SSH exec output exceeded maxBuffer'))
            settled = true
            return stream.close()
          }
        }
        stream.on('data', (chunk: Buffer) => append('out', chunk))
        stream.stderr.on('data', (chunk: Buffer) => append('err', chunk))
        stream.on('exit', (exitCode: number | null, exitSignal?: string) => {
          code = exitCode
          signal = exitSignal ?? null
        })
        stream.on('error', (reason: Error) => {
          if (!settled) reject(reason)
          settled = true
        })
        stream.on('close', () => {
          if (!settled) {
            stdout += stdoutDecoder.end()
            stderr += stderrDecoder.end()
            const recovered = recoverBufferedExecStatus(stderr, statusMarker)
            resolve({
              code: recovered.code ?? code,
              signal,
              stdout,
              stderr: recovered.stderr,
              ...(truncated ? { outputTruncated: true } : {}),
            })
          }
          settled = true
        })
        if (opts.signal) {
          const abort = (): void => {
            if (!settled) reject(abortError())
            settled = true
            stream.close()
          }
          opts.signal.addEventListener('abort', abort, { once: true })
          stream.once('close', () => opts.signal?.removeEventListener('abort', abort))
        }
        stream.end(opts.input)
      })
    } finally {
      release()
    }
  }

  execStream(
    command: string,
    args: readonly string[],
    opts: ExecOptions = {},
  ): ExecStreamHandle {
    const out = new Set<(v: string) => void>(),
      err = new Set<(v: string) => void>()
    const failures = new Set<(v: Error) => void>()
    const exits = new Set<(v: { code: number | null; signal: string | null }) => void>()
    let stream: ClientChannel | undefined,
      disposed = false,
      stdinOpen = opts.keepStdinOpen === true
    let resolveReady!: (channel: ClientChannel) => void
    let rejectReady!: (error: Error) => void
    let readySettled = false
    const ready = new Promise<ClientChannel>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // A listener-only caller may never call write/end. Keep an early channel
    // failure observable through onError without creating an unhandled promise.
    void ready.catch(() => undefined)
    const settleReady = (channel: ClientChannel): void => {
      if (readySettled) return
      readySettled = true
      resolveReady(channel)
    }
    const rejectPendingReady = (reason: unknown): Error => {
      const error = asError(reason)
      if (!readySettled) {
        readySettled = true
        rejectReady(error)
      }
      return error
    }
    const failReady = (reason: unknown): void => {
      const error = rejectPendingReady(reason)
      for (const cb of failures) cb(error)
    }
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    void this.openControlStreamChannel(command, args, opts).then(
      ({ channel }) => {
        if (disposed) {
          failReady(new Error('Exec stream is disposed'))
          return channel.close()
        }
        stream = channel
        settleReady(channel)
        let result = { code: null as number | null, signal: null as string | null }
        channel.on('data', (b: Buffer) => {
          const value = stdoutDecoder.write(b)
          if (value) for (const cb of out) cb(value)
        })
        channel.stderr.on('data', (b: Buffer) => {
          const value = stderrDecoder.write(b)
          if (value) for (const cb of err) cb(value)
        })
        channel.on('exit', (code: number | null, signal?: string) => {
          result = { code, signal: signal ?? null }
        })
        channel.on('error', (e: Error) => {
          failReady(e)
        })
        channel.on('close', () => {
          stdinOpen = false
          const finalOut = stdoutDecoder.end()
          const finalErr = stderrDecoder.end()
          if (finalOut) for (const cb of out) cb(finalOut)
          if (finalErr) for (const cb of err) cb(finalErr)
          for (const cb of exits) cb(result)
        })
        if (stdinOpen) {
          if (opts.input !== undefined) channel.write(opts.input)
        } else {
          channel.end(opts.input)
        }
      },
      (reason: unknown) => {
        failReady(reason)
      },
    )
    const writableStdin = (data?: string): void => {
      if (disposed) throw new Error('Exec stream is disposed')
      if (!stdinOpen) throw new Error('Exec stream stdin is not open')
      if (
        data !== undefined &&
        Buffer.byteLength(data, 'utf8') > MAX_EXEC_STREAM_WRITE_BYTES
      ) {
        throw new Error(
          `Exec stream write exceeds ${MAX_EXEC_STREAM_WRITE_BYTES} byte limit`,
        )
      }
    }
    return {
      onStdout: (cb) => subscribe(out, cb),
      onStderr: (cb) => subscribe(err, cb),
      onError: (cb) => subscribe(failures, cb),
      onExit: (cb) => subscribe(exits, cb),
      write: async (data) => {
        writableStdin(data)
        const channel = await ready
        writableStdin(data)
        await new Promise<void>((resolve, reject) => {
          channel.write(data, (error?: Error | null) =>
            error ? reject(error) : resolve(),
          )
        })
      },
      end: async (data) => {
        writableStdin(data)
        const channel = await ready
        writableStdin(data)
        stdinOpen = false
        await new Promise<void>((resolve, reject) => {
          channel.end(data, (error?: Error | null) => (error ? reject(error) : resolve()))
        })
      },
      kill: () => {
        disposed = true
        stdinOpen = false
        rejectPendingReady(new Error('Exec stream was killed'))
        stream?.close()
      },
      dispose: () => {
        disposed = true
        stdinOpen = false
        rejectPendingReady(new Error('Exec stream is disposed'))
        stream?.close()
      },
    }
  }

  async connectLoopback(
    endpoint: LoopbackEndpoint,
  ): Promise<import('node:stream').Duplex> {
    assertLoopbackEndpoint(endpoint)
    await this.connected()
    return this.openTunnelChannel(endpoint)
  }

  private async openTunnelChannel(endpoint: LoopbackEndpoint): Promise<ClientChannel> {
    return this.transportPool.openChannel(
      'tunnel',
      (client) =>
        new Promise<ClientChannel>((resolve, reject) => {
          try {
            client.forwardOut(
              '127.0.0.1',
              0,
              endpoint.hostname,
              endpoint.port,
              (error, stream) => (error ? reject(error) : resolve(stream)),
            )
          } catch (error) {
            reject(asError(error))
          }
        }),
      undefined,
      1,
    )
  }

  async spawnPty(opts: SpawnPtyOptions): Promise<PtyProcess> {
    const channel = await this.openTerminalPtyChannel(opts)
    const data = new Set<(v: string) => void>(),
      exits = new Set<(v: { exitCode: number; signal: number | undefined }) => void>()
    const decoder = new StringDecoder('utf8')
    let exited = false
    const reportExit = (exitCode: number): void => {
      if (exited) return
      exited = true
      for (const cb of exits) cb({ exitCode, signal: undefined })
    }
    const transportFailure = (): void => reportExit(255)
    const stopTransportFailure = this.transportPool.onChannelTransportFailure(
      channel,
      transportFailure,
    )
    channel.on('data', (b: Buffer) => {
      const value = decoder.write(b)
      if (value) for (const cb of data) cb(value)
    })
    channel.on('exit', (code: number | null) => {
      reportExit(code ?? 0)
    })
    channel.on('close', () => {
      void stopTransportFailure()
      const final = decoder.end()
      if (final) for (const cb of data) cb(final)
      // Some SSH servers close a PTY channel without sending exit-status.
      // The supervisor still needs one terminal lifecycle event, exactly once.
      reportExit(255)
    })
    return {
      pid: nextRemotePid--,
      onData: (cb) => subscribe(data, cb),
      onExit: (cb) => subscribe(exits, cb),
      write: (v) => channel.write(v),
      resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
      kill: () => channel.close(),
    }
  }

  async readFile(path: HostPath, opts: ReadFileOptions = {}): Promise<Buffer> {
    return this.files.readFile(path, opts)
  }
  async readTextFile(
    path: HostPath,
    encoding: BufferEncoding = 'utf8',
    opts: ReadFileOptions = {},
  ): Promise<string> {
    return this.files.readTextFile(path, encoding, opts)
  }
  async writeFile(
    path: HostPath,
    value: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    return this.files.writeFile(path, value, opts)
  }
  async readdir(path: HostPath): Promise<DirEntry[]> {
    return this.files.readdir(path)
  }
  async stat(path: HostPath): Promise<Stat> {
    return this.files.stat(path)
  }
  async realpath(path: HostPath): Promise<HostPath> {
    return this.files.realpath(path)
  }

  watch(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions = {},
  ): Disposer {
    return this.watches.watch(path, onEvent, opts)
  }

  private async open(): Promise<void> {
    this.promptedDuringConnect = false
    const client = this.options.clientFactory?.() ?? new Client()
    this.pendingClients.add(client)
    const generation = ++this.clientGeneration
    const previousClient = this.client
    this.client = client
    this.files.advanceGeneration()
    if (previousClient && previousClient !== client) {
      this.transportPool.retireClient(previousClient)
      try {
        previousClient.destroy()
      } catch {
        // A failed/stale transport is best-effort cleanup; its generation is
        // already unable to affect the replacement.
      }
    }
    const credentialAttempt = this.createCredentialAttempt()
    const config = this.connectConfig(
      'primary',
      undefined,
      () =>
        !this.disposed && this.client === client && this.clientGeneration === generation,
      credentialAttempt,
    )
    await new Promise<void>((resolve, reject) => {
      let ready = false
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      this.cancelConnecting = (error) => finish(error)
      client.once('ready', () => {
        ready = true
        this.rememberSuccessfulCredentials(credentialAttempt)
        // A fresh successful primary authentication is the explicit lifecycle
        // boundary that permits pool growth after a cancelled prompted attempt.
        this.poolGrowthPromptBlocked = false
        finish()
      })
      // ssh2 reports agent socket/signing failures through Client's `error`
      // event and then intentionally continues the auth ladder. Keep a
      // persistent listener so those errors neither reject open() nor consume
      // the only listener before a later fatal error.
      client.on('error', (error) => {
        if (!ready && isRecoverableAuthenticationError(error)) return
        if (!ready) finish(error)
      })
      client.on('close', () => {
        this.transportPool.retireClient(client)
        const current = this.client === client && this.clientGeneration === generation
        if (current) {
          this.client = undefined
          this.files.advanceGeneration()
        }
        if (!ready) {
          finish(new Error('SSH connection closed before authentication completed'))
          return
        }
        if (current && !this.disposed) this.scheduleReconnect()
      })
      try {
        client.connect(config)
      } catch (reason) {
        finish(asError(reason))
      }
    }).finally(() => {
      this.pendingClients.delete(client)
      this.cancelConnecting = undefined
    })
    if (this.client !== client || this.clientGeneration !== generation) {
      throw new Error('SSH connection was replaced before it became ready')
    }
    this.transportPool.registerPrimary(client)
    this.reconnectAttempt = 0
    this.setState('connected')
    const probe = new AbortController()
    const probeTimer = setTimeout(() => probe.abort(), 5_000)
    try {
      this.tier =
        (
          await this.exec('sh', ['-lc', 'command -v inotifywait >/dev/null'], {
            signal: probe.signal,
            maxBuffer: 64 * 1024,
          })
        ).code === 0
          ? 'inotify'
          : 'polling'
    } catch {
      // Capability detection is an optimization. A healthy authenticated
      // transport remains usable with the portable polling backend.
      this.tier = 'polling'
    } finally {
      clearTimeout(probeTimer)
    }
    if (this.client === client && this.clientGeneration === generation) this.notifyState()
  }

  private connectConfig(
    purpose: 'primary' | 'pool' = 'primary',
    markPrompt?: () => void,
    isActive: () => boolean = () => !this.disposed,
    credentialAttempt: SshCredentialAttempt = this.createCredentialAttempt(),
  ): ConnectConfig {
    const { config, agentSocket, identities = [], prompter } = this.options
    const attempted = new Set<string>()
    let password: string | undefined
    let authenticationCancelled = false
    let keyboardInteractiveRounds = 0
    const prompt = async (request: SshPrompt): Promise<readonly string[] | undefined> => {
      if (purpose === 'primary') this.promptedDuringConnect = true
      markPrompt?.()
      const presentedRequest =
        purpose === 'pool'
          ? {
              ...request,
              title: `Additional SSH capacity — ${request.title}`,
            }
          : request
      const answers = await this.serializedPrompt(() => prompter.prompt(presentedRequest))
      if (!isActive()) {
        authenticationCancelled = true
        return undefined
      }
      if (!answers) {
        authenticationCancelled = true
        if (purpose === 'primary') this.reconnectSuppressed = true
      }
      return answers
    }
    return {
      host: config.hostname,
      port: config.port,
      username: config.user,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      // Host verification is intentionally interactive; leave enough time to
      // compare a fingerprint without the handshake timing out underneath it.
      readyTimeout: 120_000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        if (!isActive()) {
          verify(false)
          return
        }
        const fingerprint = `SHA256:${createHash('sha256')
          .update(key)
          .digest('base64')
          .replace(/=+$/, '')}`
        const trustedFingerprint =
          this.acceptedHostFingerprint ?? this.options.trustedHostKey?.()
        if (trustedFingerprint === fingerprint) {
          verify(true)
          return
        }
        void prompt({
          hostId: this.hostId,
          kind: trustedFingerprint ? 'host-key-changed' : 'host-key',
          title: trustedFingerprint
            ? `Host key changed for ${config.alias}`
            : `Trust ${config.alias}?`,
          instructions: trustedFingerprint
            ? 'The saved host key does not match. This can indicate a machine rebuild or a man-in-the-middle attack. Verify both fingerprints before replacing it.'
            : 'Verify the SHA-256 fingerprint before trusting this host.',
          fingerprint,
          previousFingerprint: trustedFingerprint,
          prompts: [],
        })
          .then(async (a) => {
            const trusted = a?.[0]?.toLowerCase() === 'yes'
            if (trusted) {
              this.acceptedHostFingerprint = fingerprint
              await this.options.rememberHostKey?.(fingerprint)
            }
            verify(trusted)
          })
          .catch(() => verify(false))
        // This verifier is callback-only: returning a boolean would make
        // `ssh2` decide synchronously before the user can answer.
      },
      authHandler: (methods, _partial, next) => {
        const send = next as unknown as (
          value: import('ssh2').AnyAuthMethod | false,
        ) => void
        void (async (): Promise<import('ssh2').AnyAuthMethod | false> => {
          if (authenticationCancelled || !isActive()) return false
          // `ssh2` passes null before the first authentication attempt. That
          // means the server's methods are not known yet, not that none are
          // available. Start our configured ladder and narrow it after the
          // server returns its actual method list.
          const available = new Set(
            methods ?? ['agent', 'publickey', 'keyboard-interactive', 'password'],
          )
          if (agentSocket && available.has('agent') && !attempted.has('agent')) {
            attempted.add('agent')
            return { type: 'agent', username: config.user, agent: agentSocket }
          }
          const identity = identities.find((v) => !attempted.has(v.path))
          if (identity && available.has('publickey')) {
            attempted.add(identity.path)
            let passphrase: string | undefined
            const parsed = utils.parseKey(identity.privateKey)
            if (parsed instanceof Error && /encrypted|passphrase/i.test(parsed.message))
              passphrase = this.cachedPassphrases.get(identity.path)
            if (
              parsed instanceof Error &&
              /encrypted|passphrase/i.test(parsed.message) &&
              !passphrase
            ) {
              passphrase = (
                await prompt({
                  hostId: this.hostId,
                  kind: 'passphrase',
                  title: `Unlock ${identity.path}`,
                  prompts: [{ text: 'Passphrase', echo: false }],
                })
              )?.[0]
              if (passphrase) credentialAttempt.passphrases.set(identity.path, passphrase)
            }
            if (authenticationCancelled) return false
            if (!isActive()) return false
            return {
              type: 'publickey',
              username: config.user,
              key: identity.privateKey,
              passphrase,
            }
          }
          if (available.has('keyboard-interactive') && !attempted.has('keyboard')) {
            attempted.add('keyboard')
            return {
              type: 'keyboard-interactive',
              username: config.user,
              prompt: (name, instructions, _lang, prompts, finish) => {
                keyboardInteractiveRounds++
                if (keyboardInteractiveRounds > SSH_MAX_KEYBOARD_INTERACTIVE_ROUNDS) {
                  authenticationCancelled = true
                  finish([])
                  return
                }
                void prompt({
                  hostId: this.hostId,
                  kind: 'keyboard-interactive',
                  title: name || `Authenticate to ${config.alias}`,
                  instructions,
                  prompts: prompts.map((p) => ({
                    text: p.prompt,
                    echo: Boolean(p.echo),
                  })),
                })
                  .then((a) => finish([...(a ?? [])]))
                  .catch(() => finish([]))
              },
            }
          }
          if (available.has('password') && !attempted.has('password')) {
            attempted.add('password')
            password ??= this.cachedPassword
            password ??= (
              await prompt({
                hostId: this.hostId,
                kind: 'password',
                title: `Authenticate to ${config.alias}`,
                prompts: [{ text: `Password for ${config.user}`, echo: false }],
              })
            )?.[0]
            if (password && isActive()) {
              credentialAttempt.password = password
              return { type: 'password', username: config.user, password }
            }
          }
          return false
        })().then(
          (method) => send(isActive() ? method : false),
          () => send(false),
        )
      },
    }
  }

  private async openControlStreamChannel(
    command: string,
    args: readonly string[],
    opts: ExecOptions,
  ): Promise<{ channel: ClientChannel }> {
    const channel = await this.transportPool.openChannel(
      'control',
      (client) =>
        new Promise<ClientChannel>((resolve, reject) => {
          try {
            client.exec(remoteCommand(command, args, opts), (error, stream) =>
              error ? reject(error) : resolve(stream),
            )
          } catch (error) {
            reject(asError(error))
          }
        }),
      opts.signal,
    )
    return { channel }
  }

  private async openTerminalPtyChannel(opts: SpawnPtyOptions): Promise<ClientChannel> {
    return this.transportPool.openChannel(
      'terminal',
      (client) =>
        new Promise<ClientChannel>((resolve, reject) => {
          try {
            client.exec(
              remoteCommand(opts.file, opts.args ?? [], {
                cwd: opts.cwd,
                env: opts.env,
                unsetEnv: opts.unsetEnv,
              }),
              {
                pty: {
                  term: opts.name ?? 'xterm-256color',
                  cols: opts.cols ?? 80,
                  rows: opts.rows ?? 24,
                },
              },
              (error, stream) => (error ? reject(error) : resolve(stream)),
            )
          } catch (error) {
            reject(asError(error))
          }
        }),
    )
  }

  private serializedPrompt<T>(work: () => Promise<T>): Promise<T> {
    const result = this.promptTail.then(work, work)
    this.promptTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private createCredentialAttempt(): SshCredentialAttempt {
    return { passphrases: new Map() }
  }

  private rememberSuccessfulCredentials(attempt: SshCredentialAttempt): void {
    if (attempt.password) this.cachedPassword = attempt.password
    for (const [path, passphrase] of attempt.passphrases) {
      this.cachedPassphrases.set(path, passphrase)
    }
  }

  private async openAuxiliaryTransport(_role: SshTransportRole): Promise<Client> {
    const client = this.options.clientFactory?.() ?? new Client()
    this.pendingClients.add(client)
    let ready = false
    let closed = false
    let prompted = false
    const credentialAttempt = this.createCredentialAttempt()
    const config = this.connectConfig(
      'pool',
      () => {
        prompted = true
      },
      () => !this.disposed && !closed,
      credentialAttempt,
    )
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve()
        }
        client.once('ready', () => {
          ready = true
          this.rememberSuccessfulCredentials(credentialAttempt)
          finish()
        })
        client.on('error', (error) => {
          if (!ready && isRecoverableAuthenticationError(error)) return
          if (!ready) finish(error)
        })
        client.on('close', () => {
          closed = true
          this.transportPool.retireClient(client)
          if (!ready) {
            finish(new Error('SSH pool transport closed before authentication completed'))
          }
        })
        try {
          client.connect(config)
        } catch (error) {
          finish(asError(error))
        }
      })
      if (this.disposed || closed) {
        throw new Error('SSH pool transport closed before it became available')
      }
      return client
    } catch (error) {
      if (prompted) this.poolGrowthPromptBlocked = true
      if (!closed) {
        try {
          client.end()
        } catch {
          // A failed auxiliary never became pool capacity.
        }
      }
      throw error
    } finally {
      this.pendingClients.delete(client)
    }
  }

  private assertTransportGrowthAllowed(role: SshTransportRole): void {
    if (this.poolGrowthPromptBlocked) {
      throw new Error(
        `SSH ${role} capacity is unavailable after authentication was cancelled or refused`,
      )
    }
  }

  private async connected(): Promise<Client> {
    if (this.disposed || this.state === 'disconnected' || this.state === 'failed') {
      throw new Error('SSH host is disconnected; reconnect explicitly before retrying')
    }
    await this.connect()
    if (!this.client || this.state !== 'connected') throw new Error('SSH disconnected')
    return this.client
  }

  private acquireExecSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.disposed) {
      return Promise.reject(
        new Error('SSH host is disconnected; reconnect explicitly before retrying'),
      )
    }
    if (this.activeExecs < this.maxConcurrentExecs) {
      this.activeExecs++
      return Promise.resolve(this.execRelease())
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.execWaiters)[number] = { resolve, reject, signal }
      if (signal) {
        const abort = (): void => {
          const index = this.execWaiters.indexOf(waiter)
          if (index >= 0) this.execWaiters.splice(index, 1)
          reject(abortError())
        }
        waiter.abort = abort
        signal.addEventListener('abort', abort, { once: true })
      }
      this.execWaiters.push(waiter)
    })
  }

  private execRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeExecs = Math.max(0, this.activeExecs - 1)
      while (this.execWaiters.length > 0) {
        const waiter = this.execWaiters.shift()
        if (!waiter) return
        if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
        if (this.disposed) {
          waiter.reject(new Error('SSH connection cancelled'))
          continue
        }
        if (waiter.signal?.aborted) {
          waiter.reject(abortError())
          continue
        }
        this.activeExecs++
        waiter.resolve(this.execRelease())
        return
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectSuppressed || this.reconnectTimer) return
    if (this.reconnectAttempt >= 5) {
      this.setState('failed')
      return
    }
    this.reconnectAttempt++
    this.setState('reconnecting')
    const delay = Math.min(30_000, 500 * 2 ** (this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed || this.reconnectSuppressed) return
      void this.beginConnect().catch(() => {
        if (this.promptedDuringConnect) this.reconnectSuppressed = true
        this.scheduleReconnect()
      })
    }, delay)
  }
  private setState(state: HostConnectionState): void {
    if (state === this.state) return
    this.state = state
    this.notifyState()
  }
  private notifyState(): void {
    for (const cb of this.listeners) cb(this.state)
  }
}

function remoteCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
): string {
  const executable = [command, ...args].map(quote).join(' ')
  const unset = (opts.unsetEnv ?? []).map((key) => `-u ${quote(key)}`).join(' ')
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(' ')
  const environment = [unset, env].filter(Boolean).join(' ')
  const invocation = environment ? `env ${environment} ${executable}` : executable
  return opts.cwd ? `cd -- ${quote(opts.cwd.path)} && ${invocation}` : invocation
}
function remoteBufferedCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
  statusMarker: string,
): string {
  const invocation = remoteCommand(command, args, opts)
  return `( ${invocation} ); hvir_status=$?; printf '%s%s' ${quote(statusMarker)} "$hvir_status" >&2; exit "$hvir_status"`
}
function recoverBufferedExecStatus(
  stderr: string,
  statusMarker: string,
): { readonly code?: number; readonly stderr: string } {
  const markerAt = stderr.lastIndexOf(statusMarker)
  if (markerAt < 0) return { stderr }
  const rawCode = stderr.slice(markerAt + statusMarker.length)
  if (!/^\d{1,3}$/.test(rawCode)) return { stderr }
  const code = Number(rawCode)
  if (!Number.isSafeInteger(code) || code > 255) return { stderr }
  return { code, stderr: stderr.slice(0, markerAt) }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
function isRecoverableAuthenticationError(error: Error): boolean {
  const level = (error as Error & { level?: string }).level
  return (
    level === 'agent' ||
    (level === 'client-authentication' && /\bsign(?:ing|ature)?\b/i.test(error.message))
  )
}
function subscribe<T>(set: Set<(v: T) => void>, cb: (v: T) => void): Disposer {
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
function closeSshClient(client: Client): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.removeListener('close', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        client.destroy()
      } finally {
        finish()
      }
    }, 1_000)
    client.once('close', finish)
    try {
      client.end()
    } catch {
      finish()
    }
  })
}
function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
