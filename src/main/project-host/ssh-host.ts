import { createHash } from 'node:crypto'
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
  SpawnPtyOptions,
  WatchOptions,
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
  readonly trustedHostKey?: () => string | undefined
  readonly rememberHostKey?: (fingerprint: string) => Promise<void>
  /** Test seam for transport lifecycle races; production always constructs ssh2.Client. */
  readonly clientFactory?: () => Client
}

let nextRemotePid = -1

export class SshHost implements ProjectHost {
  readonly hostId: HostId
  private state: HostConnectionState = 'disconnected'
  private tier: HostWatchTier = 'polling'
  private client?: Client
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
  private readonly cache = new Map<
    string,
    { expires: number; value: Buffer | DirEntry[] }
  >()

  constructor(private readonly options: SshHostOptions) {
    this.hostId = asHostId(options.config.alias)
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
    this.cancelConnecting?.(new Error('SSH connection cancelled'))
    this.cancelConnecting = undefined
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectAttempt = 0
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    const client = this.client
    this.client = undefined
    const sftp = this.sftpSession
    this.sftpSession = undefined
    this.cache.clear()
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
      const timer = setTimeout(finish, 1_000)
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
    const client = await this.connected()
    return new Promise((resolve, reject) =>
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
    channel.on('data', (b: Buffer) => {
      const value = decoder.write(b)
      if (value) for (const cb of data) cb(value)
    })
    channel.on('exit', (code: number | null) => {
      for (const cb of exits) cb({ exitCode: code ?? 0, signal: undefined })
    })
    channel.on('close', () => {
      this.channels.delete(channel)
      const final = decoder.end()
      if (final) for (const cb of data) cb(final)
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

  async readFile(path: HostPath): Promise<Buffer> {
    this.assertPath(path)
    const key = `f:${path.path}`,
      cached = this.cached<Buffer>(key)
    if (cached) return Buffer.from(cached)
    const value = await this.sftp<Buffer>((s, done) => s.readFile(path.path, done))
    this.cache.set(key, { expires: Date.now() + 2_000, value })
    return Buffer.from(value)
  }
  async readTextFile(path: HostPath, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return (await this.readFile(path)).toString(encoding)
  }
  async writeFile(path: HostPath, value: Uint8Array | string): Promise<void> {
    this.assertPath(path)
    const data = typeof value === 'string' ? value : Buffer.from(value)
    await this.sftp<void>((s, done) => s.writeFile(path.path, data, done))
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
      stopBackend =
        this.tier === 'inotify'
          ? this.watchInotify(path, onEvent, opts)
          : this.watchPolling(path, onEvent, opts)
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
    this.client = client
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
      client.once('error', (error) => finish(error))
      client.on('close', () => {
        if (this.client === client) {
          this.client = undefined
          this.sftpSession = undefined
        }
        if (!ready) {
          finish(new Error('SSH connection closed before authentication completed'))
          return
        }
        if (ready && !this.disposed) this.scheduleReconnect()
      })
      client.connect(config)
    }).finally(() => {
      this.cancelConnecting = undefined
    })
    this.reconnectAttempt = 0
    this.setState('connected')
    this.tier =
      (await this.exec('sh', ['-lc', 'command -v inotifywait >/dev/null'])).code === 0
        ? 'inotify'
        : 'polling'
    this.notifyState()
  }

  private connectConfig(): ConnectConfig {
    const { config, agentSocket, identities = [], prompter } = this.options
    const attempted = new Set<string>()
    let password: string | undefined
    const prompt = async (request: SshPrompt): Promise<readonly string[] | undefined> => {
      this.promptedDuringConnect = true
      const answers = await prompter.prompt(request)
      if (!answers) this.reconnectSuppressed = true
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
        const type: WatchEventType = flags.includes('DELETE')
          ? 'unlink'
          : flags.includes('CREATE') || flags.includes('MOVED_TO')
            ? 'add'
            : 'change'
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
      initialized = false,
      previous = new Map<string, string>(),
      timer: ReturnType<typeof setTimeout> | undefined,
      retryMs = requestedIntervalMs ?? this.options.pollIntervalMs ?? 2_000,
      lastError: string | undefined
    const intervalMs = requestedIntervalMs ?? this.options.pollIntervalMs ?? 2_000
    const schedule = (delay: number): void => {
      if (stopped) return
      timer = setTimeout(() => void poll(), delay)
    }
    const poll = async (): Promise<void> => {
      try {
        const current = await this.pollSnapshot(path, opts)
        if (stopped) return
        if (!initialized) {
          this.invalidate(path.path)
          onEvent({ type: 'change', path })
        }
        for (const [file, stamp] of current)
          if (initialized && previous.get(file) !== stamp) {
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
        for (const [file, stamp] of previous)
          if (!current.has(file)) {
            this.invalidate(file)
            onEvent({
              type: stamp.startsWith('dir:') ? 'unlinkDir' : 'unlink',
              path: hostPath(this.hostId, file),
            })
          }
        previous = current
        initialized = true
        retryMs = intervalMs
        lastError = undefined
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
  private async pollSnapshot(
    root: HostPath,
    opts: WatchOptions,
  ): Promise<Map<string, string>> {
    const sftp = await this.getSftp()
    const result = new Map<string, string>()
    const excluded = new Set(opts.excludeDirectoryNames ?? [])
    const visit = async (directory: string): Promise<void> => {
      const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) =>
        sftp.readdir(directory, (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      )
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue
        const child = `${directory.replace(/\/$/, '')}/${entry.filename}`
        const type = fileType(entry.attrs.mode)
        result.set(
          child,
          `${type}:${entry.attrs.mtime}:${entry.attrs.size}:${entry.attrs.mode}`,
        )
        if (type === 'dir' && opts.recursive !== false && !excluded.has(entry.filename)) {
          await visit(child)
        }
      }
    }
    const rootStat = await new Promise<import('ssh2').Stats>((resolve, reject) =>
      sftp.lstat(root.path, (error, value) => (error ? reject(error) : resolve(value))),
    )
    if (fileType(rootStat.mode) !== 'dir') {
      result.set(
        root.path,
        `${fileType(rootStat.mode)}:${rootStat.mtime}:${rootStat.size}:${rootStat.mode}`,
      )
      return result
    }
    await visit(root.path)
    return result
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
    for (const key of this.cache.keys()) {
      if (
        key === `f:${normalized}` ||
        key === `d:${normalized}` ||
        key.startsWith(`f:${normalized}/`) ||
        key.startsWith(`d:${normalized}/`)
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
