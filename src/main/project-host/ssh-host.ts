import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import {
  Client,
  utils,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
} from 'ssh2'

import {
  asHostId,
  hostPath,
  type DirEntry,
  type ExecResult,
  type FileType,
  type HostConnectionState,
  type HostId,
  type HostPath,
  type HostWatchTier,
  type Stat,
  type WatchEvent,
  type WatchEventType,
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
import type { SshAliasConfig } from './ssh-config'

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
   * SFTP channels share the server's MaxSessions budget, so keep headroom for
   * them rather than opening every background Git command at once.
   */
  readonly maxConcurrentExecs?: number
  readonly trustedHostKey?: () => string | undefined
  readonly rememberHostKey?: (fingerprint: string) => Promise<void>
  /** Test seam for transport lifecycle races; production always constructs ssh2.Client. */
  readonly clientFactory?: () => Client
}

let nextRemotePid = -1
const GIT_PRIORITY_FILES = new Set(['HEAD', 'index', 'packed-refs'])

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
  private sftpSession?: Promise<SFTPWrapper>
  private readonly listeners = new Set<(state: HostConnectionState) => void>()
  private readonly channels = new Set<ClientChannel>()
  private readonly maxConcurrentExecs: number
  private activeExecs = 0
  private readonly execWaiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []
  private readonly cache = new Map<
    string,
    { expires: number; value: Buffer | DirEntry[] }
  >()
  /** Files fetched by the viewer and worth content-fingerprinting while polling. */
  private readonly pollingFiles = new Set<string>()
  /** Last content actually delivered to a reader, for optimistic remote saves. */
  private readonly readDigests = new Map<string, string>()
  private readonly fingerprintObservations = new Map<
    string,
    { metadata: string; digest: string; observeUntil: number }
  >()

  constructor(private readonly options: SshHostOptions) {
    this.hostId = asHostId(options.config.alias)
    const requestedExecs = options.maxConcurrentExecs ?? 3
    this.maxConcurrentExecs = Math.max(
      1,
      Math.min(16, Number.isFinite(requestedExecs) ? Math.floor(requestedExecs) : 3),
    )
  }
  get connectionState(): HostConnectionState {
    return this.state
  }
  get watchTier(): HostWatchTier {
    return this.tier
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
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    const client = this.client
    this.client = undefined
    const sftp = this.sftpSession
    this.sftpSession = undefined
    this.cache.clear()
    this.pollingFiles.clear()
    this.readDigests.clear()
    this.fingerprintObservations.clear()
    this.resolvedShell = undefined
    this.setState('disconnected')
    void sftp?.then(
      (session) => session.end(),
      () => undefined,
    )
    if (!client) return
    await new Promise<void>((resolve) => {
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
    if (opts.signal?.aborted) throw abortError()
    const release = await this.acquireExecSlot(opts.signal)
    try {
      const client = await this.connected()
      return await new Promise((resolve, reject) =>
        client.exec(remoteCommand(command, args, opts), (error, stream) => {
          if (error) return reject(error)
          this.channels.add(stream)
          let stdout = '',
            stderr = '',
            bytes = 0,
            code: number | null = null,
            signal: string | null = null
          let settled = false
          const stdoutDecoder = new StringDecoder('utf8')
          const stderrDecoder = new StringDecoder('utf8')
          const append = (kind: 'out' | 'err', chunk: Buffer): void => {
            bytes += chunk.length
            if (bytes > (opts.maxBuffer ?? 10 * 1024 * 1024)) {
              if (!settled) reject(new Error('SSH exec output exceeded maxBuffer'))
              settled = true
              return stream.close()
            }
            if (kind === 'out') stdout += stdoutDecoder.write(chunk)
            else stderr += stderrDecoder.write(chunk)
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
            this.channels.delete(stream)
            if (!settled) {
              stdout += stdoutDecoder.end()
              stderr += stderrDecoder.end()
              resolve({ code, signal, stdout, stderr })
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
        }),
      )
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
      disposed = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    void this.connected().then(
      (client) =>
        client.exec(remoteCommand(command, args, opts), (error, channel) => {
          if (error) {
            for (const cb of failures) cb(error)
            return
          }
          if (disposed) return channel.close()
          stream = channel
          this.channels.add(channel)
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
            for (const cb of failures) cb(e)
          })
          channel.on('close', () => {
            this.channels.delete(channel)
            const finalOut = stdoutDecoder.end()
            const finalErr = stderrDecoder.end()
            if (finalOut) for (const cb of out) cb(finalOut)
            if (finalErr) for (const cb of err) cb(finalErr)
            for (const cb of exits) cb(result)
          })
          channel.end(opts.input)
        }),
      (reason: unknown) => {
        for (const cb of failures) cb(asError(reason))
      },
    )
    return {
      onStdout: (cb) => subscribe(out, cb),
      onStderr: (cb) => subscribe(err, cb),
      onError: (cb) => subscribe(failures, cb),
      onExit: (cb) => subscribe(exits, cb),
      kill: () => stream?.close(),
      dispose: () => {
        disposed = true
        stream?.close()
      },
    }
  }

  async spawnPty(opts: SpawnPtyOptions): Promise<PtyProcess> {
    const client = await this.connected()
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.exec(
        remoteCommand(opts.file, opts.args ?? [], { cwd: opts.cwd, env: opts.env }),
        {
          pty: {
            term: opts.name ?? 'xterm-256color',
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
          },
        },
        (error, stream) => (error ? reject(error) : resolve(stream)),
      ),
    )
    this.channels.add(channel)
    const data = new Set<(v: string) => void>(),
      exits = new Set<(v: { exitCode: number; signal: number | undefined }) => void>()
    const decoder = new StringDecoder('utf8')
    let exited = false
    const reportExit = (exitCode: number): void => {
      if (exited) return
      exited = true
      for (const cb of exits) cb({ exitCode, signal: undefined })
    }
    channel.on('data', (b: Buffer) => {
      const value = decoder.write(b)
      if (value) for (const cb of data) cb(value)
    })
    channel.on('exit', (code: number | null) => {
      reportExit(code ?? 0)
    })
    channel.on('close', () => {
      this.channels.delete(channel)
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
    this.assertPath(path)
    if (opts.pollingInterest) this.pollingFiles.add(path.path)
    const key = `f:${path.path}`,
      cached = this.cached<Buffer>(key)
    if (cached) {
      if (opts.pollingInterest) this.readDigests.set(path.path, contentDigest(cached))
      return Buffer.from(cached)
    }
    const value = await this.sftp<Buffer>((s, done) => s.readFile(path.path, done))
    this.cache.set(key, { expires: Date.now() + 2_000, value })
    if (opts.pollingInterest) this.readDigests.set(path.path, contentDigest(value))
    return Buffer.from(value)
  }
  async readTextFile(
    path: HostPath,
    encoding: BufferEncoding = 'utf8',
    opts: ReadFileOptions = {},
  ): Promise<string> {
    return (await this.readFile(path, opts)).toString(encoding)
  }
  async writeFile(
    path: HostPath,
    value: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    this.assertPath(path)
    const data = Buffer.from(value)
    const parent = remoteParent(path.path)
    const basename = path.path.slice(parent === '/' ? 1 : parent.length + 1)
    const temporary = `${parent === '/' ? '' : parent}/.${basename}.hvir-${randomUUID()}.tmp`
    let mode: number | undefined
    try {
      const attrs = await this.sftp<import('ssh2').Stats>((s, done) =>
        s.lstat(path.path, done),
      )
      mode = attrs.mode & 0o777
    } catch (reason) {
      if (!isNoSuchFile(reason)) throw reason
    }
    const expectedDigest = this.readDigests.get(path.path)
    try {
      await this.sftp<void>((s, done) =>
        s.writeFile(temporary, data, mode === undefined ? {} : { mode }, done),
      )
      // Revalidate after uploading the sibling temporary so an external edit
      // during a slow transfer cannot be silently replaced by the rename.
      if (opts.expectedMtimeMs !== undefined) {
        const currentAttrs = await this.sftp<import('ssh2').Stats>((s, done) =>
          s.lstat(path.path, done),
        )
        if (currentAttrs.mtime * 1_000 !== opts.expectedMtimeMs) {
          throw fileChangedError(true)
        }
      }
      if (expectedDigest !== undefined) {
        const current = await this.sftp<Buffer>((s, done) => s.readFile(path.path, done))
        if (contentDigest(current) !== expectedDigest) throw fileChangedError(true)
      }
      try {
        // OpenSSH's extension has POSIX replacement semantics. Standard SFTP
        // rename is retained as a fallback for non-OpenSSH servers.
        await this.sftp<void>((s, done) =>
          s.ext_openssh_rename(temporary, path.path, done),
        )
      } catch {
        await this.sftp<void>((s, done) => s.rename(temporary, path.path, done))
      }
    } catch (reason) {
      await this.sftp<void>((s, done) => s.unlink(temporary, done)).catch(() => undefined)
      throw reason
    }
    this.readDigests.set(path.path, contentDigest(data))
    this.fingerprintObservations.delete(path.path)
    this.invalidate(path.path)
  }
  async readdir(path: HostPath): Promise<DirEntry[]> {
    this.assertPath(path)
    const key = `d:${path.path}`,
      cached = this.cached<DirEntry[]>(key)
    if (cached) return [...cached]
    const raw = await this.sftp<import('ssh2').FileEntry[]>((s, done) =>
      s.readdir(path.path, done),
    )
    const value = raw
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({ name: e.filename, type: fileType(e.attrs.mode) }))
    this.cache.set(key, { expires: Date.now() + 2_000, value })
    return [...value]
  }
  async stat(path: HostPath): Promise<Stat> {
    this.assertPath(path)
    const a = await this.sftp<import('ssh2').Stats>((s, done) => s.lstat(path.path, done))
    return { type: fileType(a.mode), size: a.size, mtimeMs: a.mtime * 1000, mode: a.mode }
  }
  async realpath(path: HostPath): Promise<HostPath> {
    this.assertPath(path)
    return hostPath(
      this.hostId,
      await this.sftp<string>((s, done) => s.realpath(path.path, done)),
    )
  }

  watch(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions = {},
  ): Disposer {
    this.assertPath(path)
    let stopped = false
    let stopBackend: Disposer | undefined
    const start = (): void => {
      if (stopped || stopBackend || this.state !== 'connected') return
      const stopWatch =
        this.tier === 'inotify'
          ? this.watchInotify(path, onEvent, opts)
          : this.watchPolling(path, onEvent, opts)
      const pulseIntervalMs =
        this.options.refreshPulseIntervalMs ?? this.options.pollIntervalMs ?? 2_000
      let pulseTimer: ReturnType<typeof setTimeout> | undefined
      const pulse = (): void => {
        if (stopped || this.state !== 'connected') return
        this.invalidate(path.path)
        onEvent({ type: 'change', path, synthetic: 'refresh' })
        pulseTimer = setTimeout(pulse, pulseIntervalMs)
      }
      pulseTimer = setTimeout(pulse, pulseIntervalMs)
      stopBackend = () => {
        if (pulseTimer) clearTimeout(pulseTimer)
        return stopWatch()
      }
    }
    const stopState = this.onConnectionState((state) => {
      if (state === 'connected') start()
      else {
        void stopBackend?.()
        stopBackend = undefined
      }
    })
    return () => {
      stopped = true
      void stopState()
      void stopBackend?.()
      stopBackend = undefined
    }
  }

  private async open(): Promise<void> {
    this.promptedDuringConnect = false
    const client = this.options.clientFactory?.() ?? new Client()
    const generation = ++this.clientGeneration
    const previousClient = this.client
    this.client = client
    this.sftpSession = undefined
    if (previousClient && previousClient !== client) {
      try {
        previousClient.destroy()
      } catch {
        // A failed/stale transport is best-effort cleanup; its generation is
        // already unable to affect the replacement.
      }
    }
    const config = this.connectConfig()
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
        const current = this.client === client && this.clientGeneration === generation
        if (current) {
          this.client = undefined
          this.sftpSession = undefined
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
      this.cancelConnecting = undefined
    })
    if (this.client !== client || this.clientGeneration !== generation) {
      throw new Error('SSH connection was replaced before it became ready')
    }
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

  private connectConfig(): ConnectConfig {
    const { config, agentSocket, identities = [], prompter } = this.options
    const attempted = new Set<string>()
    let password: string | undefined
    let authenticationCancelled = false
    const prompt = async (request: SshPrompt): Promise<readonly string[] | undefined> => {
      this.promptedDuringConnect = true
      const answers = await prompter.prompt(request)
      if (!answers) {
        authenticationCancelled = true
        this.reconnectSuppressed = true
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
        const fingerprint = `SHA256:${createHash('sha256')
          .update(key)
          .digest('base64')
          .replace(/=+$/, '')}`
        const trustedFingerprint = this.options.trustedHostKey?.()
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
            if (trusted) await this.options.rememberHostKey?.(fingerprint)
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
          if (authenticationCancelled) return false
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
              passphrase = (
                await prompt({
                  hostId: this.hostId,
                  kind: 'passphrase',
                  title: `Unlock ${identity.path}`,
                  prompts: [{ text: 'Passphrase', echo: false }],
                })
              )?.[0]
            if (authenticationCancelled) return false
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
            password ??= (
              await prompt({
                hostId: this.hostId,
                kind: 'password',
                title: `Authenticate to ${config.alias}`,
                prompts: [{ text: `Password for ${config.user}`, echo: false }],
              })
            )?.[0]
            if (password) return { type: 'password', username: config.user, password }
          }
          return false
        })().then(send, () => send(false))
      },
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
  private sftp<T>(
    op: (s: SFTPWrapper, done: (e: Error | null | undefined, value: T) => void) => void,
  ): Promise<T> {
    return this.getSftp().then(
      (s) =>
        new Promise<T>((resolve, reject) =>
          op(s, (reason, value) => {
            if (reason) reject(reason)
            else resolve(value)
          }),
        ),
    )
  }

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftpSession) return this.sftpSession
    const pending = this.connected().then(
      (client) =>
        new Promise<SFTPWrapper>((resolve, reject) =>
          client.sftp((error, session) => (error ? reject(error) : resolve(session))),
        ),
    )
    this.sftpSession = pending
    void pending.then(
      (session) => {
        session.once('close', () => {
          if (this.sftpSession === pending) this.sftpSession = undefined
        })
      },
      () => {
        if (this.sftpSession === pending) this.sftpSession = undefined
      },
    )
    return pending
  }

  private watchInotify(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions,
  ): Disposer {
    let stopped = false
    const args = ['-m', '-e', 'modify,create,delete,move', '--format', '%e|%w%f']
    if (opts.recursive !== false) args.push('-r')
    if (opts.excludeDirectoryNames?.length) {
      const names = opts.excludeDirectoryNames.map(escapeRegex).join('|')
      args.push('--exclude', `(^|/)(${names})(/|$)`)
    }
    args.push(path.path)
    const handle = this.execStream('inotifywait', args)
    let pending = ''
    handle.onStdout((chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const at = line.indexOf('|')
        if (at < 0) continue
        const flags = line.slice(0, at),
          changed = line.slice(at + 1)
        const type = inotifyEventType(flags)
        this.invalidate(changed)
        onEvent({ type, path: hostPath(this.hostId, changed) })
      }
    })
    let pollingStop: Disposer | undefined
    let watchdogStop: Disposer | undefined = this.watchPolling(
      path,
      onEvent,
      opts,
      this.options.watchdogIntervalMs ??
        Math.max(10_000, this.options.pollIntervalMs ?? 2_000),
    )
    let fallingBack = false
    const fallback = (error?: Error): void => {
      if (stopped || pollingStop || fallingBack) return
      fallingBack = true
      if (error) opts.onError?.(error)
      handle.dispose()
      void watchdogStop?.()
      watchdogStop = undefined
      this.tier = 'polling'
      pollingStop = this.watchPolling(path, onEvent, opts)
      this.notifyState()
      fallingBack = false
    }
    handle.onError((e) => fallback(e))
    handle.onExit(({ code }) => {
      if (!stopped) fallback(new Error(`inotifywait exited (${String(code)})`))
    })
    return () => {
      stopped = true
      handle.dispose()
      void watchdogStop?.()
      void pollingStop?.()
    }
  }
  private watchPolling(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions,
    requestedIntervalMs?: number,
  ): Disposer {
    let stopped = false,
      priorityInitialized = false,
      previousPriority = new Map<string, string>(),
      slowInitialized = false,
      previousSlow = new Map<string, string>(),
      timer: ReturnType<typeof setTimeout> | undefined,
      retryMs = requestedIntervalMs ?? this.options.pollIntervalMs ?? 2_000,
      lastError: string | undefined
    const intervalMs = requestedIntervalMs ?? this.options.pollIntervalMs ?? 2_000
    const slowBaseMs = this.options.slowScanIntervalMs ?? Math.max(30_000, intervalMs * 5)
    const slowMaxMs =
      this.options.maxSlowScanIntervalMs ?? Math.max(5 * 60_000, slowBaseMs)
    const directoryBatchSize = Math.max(
      1,
      Math.min(64, this.options.pollDirectoryBatchSize ?? 4),
    )
    let slowDelayMs = slowBaseMs
    let nextSlowCycleAt = 0
    let slowCycleActive = false
    let slowQueue: string[] = []
    let slowVisited = new Set<string>()
    let slowSnapshot = new Map<string, string>()
    let slowError: string | undefined
    const schedule = (delay: number): void => {
      if (stopped) return
      timer = setTimeout(() => void poll(), delay)
    }
    const emitChanges = (
      previous: Map<string, string>,
      current: Map<string, string>,
      initialized: boolean,
    ): boolean => {
      if (!initialized) return false
      let changed = false
      for (const [file, stamp] of current) {
        if (previous.get(file) === stamp) continue
        changed = true
        this.invalidate(file)
        onEvent({
          type: previous.has(file)
            ? 'change'
            : stamp.startsWith('dir:')
              ? 'addDir'
              : 'add',
          path: hostPath(this.hostId, file),
        })
      }
      for (const [file, stamp] of previous) {
        if (current.has(file)) continue
        changed = true
        this.fingerprintObservations.delete(file)
        this.invalidate(file)
        onEvent({
          type: stamp.startsWith('dir:') ? 'unlinkDir' : 'unlink',
          path: hostPath(this.hostId, file),
        })
      }
      return changed
    }
    const poll = async (): Promise<void> => {
      try {
        const current = await this.pollPrioritySnapshot(path, opts)
        if (stopped) return
        if (!priorityInitialized) {
          this.invalidate(path.path)
          onEvent({ type: 'change', path, synthetic: 'refresh' })
        }
        emitChanges(previousPriority, current, priorityInitialized)
        previousPriority = current
        priorityInitialized = true
        retryMs = intervalMs
        lastError = undefined

        // Recursive safety coverage advances in small directory batches. The
        // fast path above keeps fetched/open files and the root responsive;
        // this cycle is only a backstop for silent/missed deep-tree events.
        if (
          opts.recursive !== false &&
          (slowCycleActive || Date.now() >= nextSlowCycleAt)
        ) {
          if (!slowCycleActive) {
            slowCycleActive = true
            slowQueue = [path.path]
            slowVisited = new Set([path.path])
            slowSnapshot = new Map()
          }
          try {
            await this.pollDirectoryBatch(
              slowQueue,
              slowVisited,
              slowSnapshot,
              opts,
              directoryBatchSize,
            )
            if (!slowQueue.length) {
              // Root entries and fetched files already belong to the priority
              // map, so omit them from the slow diff to avoid duplicate events.
              for (const file of current.keys()) slowSnapshot.delete(file)
              for (const file of this.pollingFiles) {
                slowSnapshot.delete(file)
                previousSlow.delete(file)
              }
              const changed = emitChanges(previousSlow, slowSnapshot, slowInitialized)
              previousSlow = slowSnapshot
              slowInitialized = true
              slowCycleActive = false
              slowDelayMs = changed ? slowBaseMs : Math.min(slowMaxMs, slowDelayMs * 2)
              nextSlowCycleAt = Date.now() + slowDelayMs
              slowError = undefined
            }
          } catch (reason) {
            const error = asError(reason)
            if (error.message !== slowError) opts.onError?.(error)
            slowError = error.message
            slowCycleActive = false
            slowDelayMs = Math.min(slowMaxMs, Math.max(slowBaseMs, slowDelayMs * 2))
            nextSlowCycleAt = Date.now() + slowDelayMs
          }
        }
      } catch (e) {
        if (stopped) return
        const error = asError(e)
        if (error.message !== lastError) opts.onError?.(error)
        lastError = error.message
        retryMs = Math.min(30_000, Math.max(intervalMs, retryMs * 2))
      } finally {
        schedule(retryMs)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
  private async pollPrioritySnapshot(
    root: HostPath,
    opts: WatchOptions,
  ): Promise<Map<string, string>> {
    const sftp = await this.getSftp()
    const result = new Map<string, string>()
    const rootAttrs = await sftpLstat(sftp, root.path)
    if (fileType(rootAttrs.mode) !== 'dir') {
      result.set(
        root.path,
        await this.pollStamp(
          sftp,
          root.path,
          rootAttrs,
          this.pollingFiles.has(root.path),
        ),
      )
      return result
    }

    const entries = await sftpReaddir(sftp, root.path)
    const entryNames = new Set(entries.map((entry) => entry.filename))
    const gitMetadataDirectory =
      opts.recursive === false &&
      entryNames.has('HEAD') &&
      (entryNames.has('index') ||
        entryNames.has('objects') ||
        entryNames.has('commondir'))
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue
      const child = remoteChild(root.path, entry.filename)
      const fingerprint =
        this.pollingFiles.has(child) ||
        (gitMetadataDirectory && GIT_PRIORITY_FILES.has(entry.filename))
      result.set(child, await this.pollStamp(sftp, child, entry.attrs, fingerprint))
    }

    if (opts.recursive !== false) {
      const prefix = root.path === '/' ? '/' : `${root.path}/`
      for (const file of this.pollingFiles) {
        if (!file.startsWith(prefix) || result.has(file)) continue
        try {
          const attrs = await sftpLstat(sftp, file)
          result.set(file, await this.pollStamp(sftp, file, attrs, true))
        } catch (reason) {
          if (!isNoSuchFile(reason)) throw reason
          // Omission is the deletion signal against the previous priority map.
        }
      }
    }
    return result
  }
  private async pollDirectoryBatch(
    queue: string[],
    visited: Set<string>,
    result: Map<string, string>,
    opts: WatchOptions,
    limit: number,
  ): Promise<void> {
    const sftp = await this.getSftp()
    const excluded = new Set(opts.excludeDirectoryNames ?? [])
    for (let count = 0; count < limit && queue.length; count++) {
      const directory = queue.shift()
      if (!directory) break
      const entries = await sftpReaddir(sftp, directory)
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue
        const child = remoteChild(directory, entry.filename)
        const type = fileType(entry.attrs.mode)
        result.set(child, metadataStamp(entry.attrs))
        if (type === 'dir' && !excluded.has(entry.filename) && !visited.has(child)) {
          visited.add(child)
          queue.push(child)
        }
      }
    }
  }
  private async pollStamp(
    sftp: SFTPWrapper,
    path: string,
    attrs: import('ssh2').Attributes,
    fingerprint: boolean,
  ): Promise<string> {
    const metadata = metadataStamp(attrs)
    if (fileType(attrs.mode) !== 'file' || !fingerprint) return metadata

    const now = Date.now()
    const previous = this.fingerprintObservations.get(path)
    const metadataChanged = previous?.metadata !== metadata
    if (!previous || metadataChanged || now <= previous.observeUntil) {
      const digest = contentDigest(await sftpReadFile(sftp, path))
      const observeUntil =
        !previous || metadataChanged
          ? now + (this.options.fingerprintObservationWindowMs ?? 5_000)
          : previous.observeUntil
      this.fingerprintObservations.set(path, { metadata, digest, observeUntil })
      return `${metadata}:${digest}`
    }
    return `${metadata}:${previous.digest}`
  }
  private cached<T extends Buffer | DirEntry[]>(key: string): T | undefined {
    const v = this.cache.get(key)
    if (!v || v.expires < Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return v.value as T
  }
  private invalidate(path: string): void {
    const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path
    const descendantPrefix = normalized === '/' ? '/' : `${normalized}/`
    for (const key of this.cache.keys()) {
      if (
        key === `f:${normalized}` ||
        key === `d:${normalized}` ||
        key.startsWith(`f:${descendantPrefix}`) ||
        key.startsWith(`d:${descendantPrefix}`)
      ) {
        this.cache.delete(key)
      }
    }
    // A create/delete/rename changes every cached directory listing between
    // the entry and the watched root. Without parent invalidation an inotify
    // burst can trigger a refresh inside the listing TTL, re-read stale cache,
    // and then remain stale forever because no later event arrives.
    let parent = remoteParent(normalized)
    for (;;) {
      this.cache.delete(`d:${parent}`)
      if (parent === '/') break
      parent = remoteParent(parent)
    }
  }
  private assertPath(path: HostPath): void {
    if (path.hostId !== this.hostId)
      throw new Error(`SshHost expected ${this.hostId}, got ${path.hostId}`)
  }
}

function remoteCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env'>,
): string {
  const executable = [command, ...args].map(quote).join(' ')
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(' ')
  const invocation = env ? `env ${env} ${executable}` : executable
  return opts.cwd ? `cd -- ${quote(opts.cwd.path)} && ${invocation}` : invocation
}
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function remoteParent(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}
function remoteChild(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`
}
function metadataStamp(attrs: import('ssh2').Attributes): string {
  return `${fileType(attrs.mode)}:${attrs.mtime}:${attrs.size}:${attrs.mode}`
}
function sftpLstat(sftp: SFTPWrapper, path: string): Promise<import('ssh2').Stats> {
  return new Promise((resolve, reject) =>
    sftp.lstat(path, (error, value) => (error ? reject(error) : resolve(value))),
  )
}
function sftpReaddir(
  sftp: SFTPWrapper,
  path: string,
): Promise<import('ssh2').FileEntry[]> {
  return new Promise((resolve, reject) =>
    sftp.readdir(path, (error, value) => (error ? reject(error) : resolve(value))),
  )
}
function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.readFile(path, (error, value) => (error ? reject(error) : resolve(value))),
  )
}
function inotifyEventType(flags: string): WatchEventType {
  const directory = flags.includes('ISDIR')
  if (flags.includes('DELETE') || flags.includes('MOVED_FROM')) {
    return directory ? 'unlinkDir' : 'unlink'
  }
  if (flags.includes('CREATE') || flags.includes('MOVED_TO')) {
    return directory ? 'addDir' : 'add'
  }
  return 'change'
}
function isRecoverableAuthenticationError(error: Error): boolean {
  const level = (error as Error & { level?: string }).level
  return (
    level === 'agent' ||
    (level === 'client-authentication' && /\bsign(?:ing|ature)?\b/i.test(error.message))
  )
}
function isNoSuchFile(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}
function contentDigest(value: Buffer): string {
  return createHash('sha256').update(value).digest('base64')
}
function fileChangedError(remote: boolean): Error {
  return new Error(
    `File changed${remote ? ' on the remote host' : ''} since it was opened; reload before saving`,
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
function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
function fileType(mode: number): FileType {
  const type = mode & 0o170000
  return type === 0o100000
    ? 'file'
    : type === 0o040000
      ? 'dir'
      : type === 0o120000
        ? 'symlink'
        : 'other'
}
