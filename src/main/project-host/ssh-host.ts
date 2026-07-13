import { createHash } from 'node:crypto'

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
  readonly kind: 'password' | 'passphrase' | 'keyboard-interactive' | 'host-key'
  readonly title: string
  readonly instructions?: string
  readonly fingerprint?: string
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
  readonly isHostKeyTrusted?: (fingerprint: string) => boolean
  readonly rememberHostKey?: (fingerprint: string) => Promise<void>
}

let nextRemotePid = -1

export class SshHost implements ProjectHost {
  readonly hostId: HostId
  private state: HostConnectionState = 'disconnected'
  private tier: HostWatchTier = 'polling'
  private client?: Client
  private connecting?: Promise<void>
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private resolvedShell?: string
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
    if (this.state === 'connected') return
    if (this.connecting) return this.connecting
    this.disposed = false
    this.setState(this.reconnectAttempt ? 'reconnecting' : 'connecting')
    this.connecting = this.open()
      .catch((error: unknown) => {
        this.setState('failed')
        throw error
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }
  dispose(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    this.client?.end()
    this.client = undefined
    this.cache.clear()
    this.resolvedShell = undefined
    this.setState('disconnected')
    return Promise.resolve()
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
        const append = (kind: 'out' | 'err', chunk: Buffer): void => {
          bytes += chunk.length
          if (bytes > (opts.maxBuffer ?? 10 * 1024 * 1024)) {
            if (!settled) reject(new Error('SSH exec output exceeded maxBuffer'))
            settled = true
            return stream.close()
          }
          if (kind === 'out') stdout += chunk.toString('utf8')
          else stderr += chunk.toString('utf8')
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
          if (!settled) resolve({ code, signal, stdout, stderr })
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
            for (const cb of out) cb(b.toString('utf8'))
          })
          channel.stderr.on('data', (b: Buffer) => {
            for (const cb of err) cb(b.toString('utf8'))
          })
          channel.on('exit', (code: number | null, signal?: string) => {
            result = { code, signal: signal ?? null }
          })
          channel.on('error', (e: Error) => {
            for (const cb of failures) cb(e)
          })
          channel.on('close', () => {
            this.channels.delete(channel)
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
    channel.on('data', (b: Buffer) => {
      for (const cb of data) cb(b.toString('utf8'))
    })
    channel.on('exit', (code: number | null) => {
      for (const cb of exits) cb({ exitCode: code ?? 0, signal: undefined })
    })
    channel.on('close', () => this.channels.delete(channel))
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
    const client = new Client()
    this.client = client
    const config = this.connectConfig()
    await new Promise<void>((resolve, reject) => {
      let ready = false
      client.once('ready', () => {
        ready = true
        resolve()
      })
      client.once('error', reject)
      client.on('close', () => {
        this.client = undefined
        if (ready && !this.disposed) this.scheduleReconnect()
      })
      client.connect(config)
    })
    this.reconnectAttempt = 0
    this.setState('connected')
    this.tier =
      (await this.exec('sh', ['-lc', 'command -v inotifywait >/dev/null'])).code === 0
        ? 'inotify'
        : 'polling'
  }

  private connectConfig(): ConnectConfig {
    const { config, agentSocket, identities = [], prompter } = this.options
    const attempted = new Set<string>()
    let password: string | undefined
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
        if (this.options.isHostKeyTrusted?.(fingerprint)) {
          verify(true)
          return
        }
        void prompter
          .prompt({
            kind: 'host-key',
            title: `Trust ${config.alias}?`,
            instructions: 'Verify the SHA-256 fingerprint before trusting this host.',
            fingerprint,
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
                await prompter.prompt({
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
                void prompter
                  .prompt({
                    kind: 'keyboard-interactive',
                    title: name || `Authenticate to ${config.alias}`,
                    instructions,
                    prompts: prompts.map((p) => ({
                      text: p.prompt,
                      echo: Boolean(p.echo),
                    })),
                  })
                  .then((a) => finish([...(a ?? [])]))
              },
            }
          }
          if (available.has('password') && !attempted.has('password')) {
            attempted.add('password')
            password ??= (
              await prompter.prompt({
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
    await this.connect()
    if (!this.client || this.state !== 'connected') throw new Error('SSH disconnected')
    return this.client
  }
  private scheduleReconnect(): void {
    this.reconnectAttempt++
    this.setState('reconnecting')
    const delay = Math.min(30_000, 500 * 2 ** (this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }
  private setState(state: HostConnectionState): void {
    if (state === this.state) return
    this.state = state
    for (const cb of this.listeners) cb(state)
  }
  private sftp<T>(
    op: (s: SFTPWrapper, done: (e: Error | null | undefined, value: T) => void) => void,
  ): Promise<T> {
    return this.connected().then(
      (client) =>
        new Promise<T>((resolve, reject) =>
          client.sftp((error, s) => {
            if (error) return reject(error)
            op(s, (reason, value) => {
              s.end()
              if (reason) reject(reason)
              else resolve(value)
            })
          }),
        ),
    )
  }

  private watchInotify(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions,
  ): Disposer {
    const args = ['-m', '-e', 'modify,create,delete,move', '--format', '%e|%w%f']
    if (opts.recursive !== false) args.push('-r')
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
    handle.onError((e) => opts.onError?.(e))
    return () => handle.dispose()
  }
  private watchPolling(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions,
  ): Disposer {
    let stopped = false,
      initialized = false,
      previous = new Map<string, string>(),
      timer: ReturnType<typeof setTimeout> | undefined,
      retryMs = this.options.pollIntervalMs ?? 2_000,
      lastError: string | undefined
    const intervalMs = this.options.pollIntervalMs ?? 2_000
    const schedule = (delay: number): void => {
      if (stopped) return
      timer = setTimeout(() => void poll(), delay)
    }
    const poll = async (): Promise<void> => {
      try {
        const current = await this.pollSnapshot(path, opts)
        for (const [file, stamp] of current)
          if (initialized && previous.get(file) !== stamp) {
            this.invalidate(file)
            onEvent({
              type: previous.has(file) ? 'change' : 'add',
              path: hostPath(this.hostId, file),
            })
          }
        for (const file of previous.keys())
          if (!current.has(file))
            onEvent({ type: 'unlink', path: hostPath(this.hostId, file) })
        previous = current
        initialized = true
        retryMs = intervalMs
        lastError = undefined
      } catch (e) {
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
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      void this.connected().then(
        (client) =>
          client.sftp((error, value) => (error ? reject(error) : resolve(value))),
        reject,
      )
    })
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
    try {
      await visit(root.path)
      return result
    } finally {
      sftp.end()
    }
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
    for (const key of this.cache.keys())
      if (key.endsWith(path) || key.includes(`${path}/`)) this.cache.delete(key)
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
