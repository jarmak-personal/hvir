/**
 * `ProjectHost` — the transport seam (ADR-010).
 *
 * Every filesystem, exec, PTY, and watch operation in hvir goes through a
 * `ProjectHost`. `LocalHost` is the default implementation; `SshHost` (Phase 4)
 * will implement the same interface over ssh2. Nothing above this seam knows or
 * cares whether a project is local or remote — remoteness is transport, not a
 * server. All paths are host-qualified `HostPath`s.
 */

import type {
  HostId,
  HostPath,
  DirEntry,
  Stat,
  WatchEvent,
  ExecResult,
  HostConnectionState,
  HostWatchTier,
  Disposer,
} from '../../shared'

export type { Disposer }

/** Maximum UTF-8 payload accepted by one duplex exec-stream write. */
export const MAX_EXEC_STREAM_WRITE_BYTES = 256 * 1024

export interface ExecOptions {
  readonly cwd?: HostPath
  readonly env?: Record<string, string>
  /** Remove inherited variables before applying `env`. */
  readonly unsetEnv?: readonly string[]
  /** Written to the child's stdin before the stream is exposed. */
  readonly input?: string
  /**
   * Keep stdin open for `ExecStreamHandle.write()` / `.end()`.
   *
   * Streaming stdin remains closed by default so existing commands that read
   * until EOF cannot hang. Buffered `exec()` always ignores this option and
   * closes stdin after `input`.
   */
  readonly keepStdinOpen?: boolean
  readonly signal?: AbortSignal
  /** Max bytes to buffer across stdout+stderr before failing. */
  readonly maxBuffer?: number
  /** Terminate and return the buffered prefix instead of rejecting at maxBuffer. */
  readonly allowTruncatedOutput?: boolean
  /** Also terminate after this many NUL-delimited stdout records. */
  readonly maxStdoutNulRecords?: number
}

export interface ExecStreamHandle {
  onStdout(cb: (chunk: string) => void): Disposer
  onStderr(cb: (chunk: string) => void): Disposer
  onError(cb: (error: Error) => void): Disposer
  onExit(cb: (result: { code: number | null; signal: string | null }) => void): Disposer
  /** Write one bounded UTF-8 payload, resolving after the transport accepts it. */
  write(data: string): Promise<void>
  /** Optionally write one final bounded payload, then close stdin. */
  end(data?: string): Promise<void>
  kill(signal?: string): void
  dispose(): void
}

export interface WatchOptions {
  readonly recursive?: boolean
  /**
   * Additional host-qualified roots owned by the same backend. They follow the
   * same depth policy as `path`; callers use this to keep UI-driven shallow
   * interests bounded without consuming one SSH channel per directory.
   */
  readonly additionalPaths?: readonly HostPath[]
  /** Directory basenames to prune entirely from a recursive watch. */
  readonly excludeDirectoryNames?: readonly string[]
  /** Watch backends report asynchronous failures here instead of throwing. */
  readonly onError?: (error: Error) => void
}

export interface WriteFileOptions {
  /** Reject if the live file no longer has the version originally read. */
  readonly expectedMtimeMs?: number
}

export interface ReadFileOptions {
  /** Keep this user-visible file on the SSH polling fast path. */
  readonly pollingInterest?: boolean
}

export interface SpawnPtyOptions {
  readonly file: string
  readonly args?: readonly string[]
  readonly cwd: HostPath
  readonly env?: Record<string, string>
  /** Remove inherited variables before applying `env`. */
  readonly unsetEnv?: readonly string[]
  readonly cols?: number
  readonly rows?: number
  /** TERM name; defaults to `xterm-256color`. */
  readonly name?: string
}

export interface PtyExit {
  readonly exitCode: number
  readonly signal: number | undefined
}

/** A live pseudo-terminal. Produced only via the PTY supervisor (ADR-006). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): Disposer
  onExit(cb: (e: PtyExit) => void): Disposer
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface ProjectHost {
  readonly hostId: HostId
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier

  /** Establish the connection (a no-op for LocalHost). */
  connect(): Promise<void>
  /** Tear down the connection and all resources it owns. */
  dispose(): Promise<void>
  onConnectionState(cb: (state: HostConnectionState) => void): Disposer

  /** Resolve the interactive shell on this host (never inherit it from another host). */
  defaultShell(): Promise<string>

  /** Buffered command execution. */
  exec(command: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>
  /** Streaming command execution. */
  execStream(
    command: string,
    args: readonly string[],
    opts?: ExecOptions,
  ): ExecStreamHandle

  /**
   * Low-level PTY primitive.
   *
   * DO NOT CALL DIRECTLY. Every PTY must be spawned through the PTY supervisor,
   * which is the only permitted caller (enforced by lint). See ADR-006.
   *
   * Async so remote hosts (SshHost) and lazy native-module loading fit the same
   * shape.
   */
  spawnPty(opts: SpawnPtyOptions): Promise<PtyProcess>

  readFile(path: HostPath, opts?: ReadFileOptions): Promise<Buffer>
  readTextFile(
    path: HostPath,
    encoding?: BufferEncoding,
    opts?: ReadFileOptions,
  ): Promise<string>
  writeFile(
    path: HostPath,
    data: Uint8Array | string,
    opts?: WriteFileOptions,
  ): Promise<void>
  readdir(path: HostPath): Promise<DirEntry[]>
  stat(path: HostPath): Promise<Stat>
  /** Canonicalize through symlinks on the project host. */
  realpath(path: HostPath): Promise<HostPath>

  /** Watch a path; returns a disposer that stops watching. */
  watch(path: HostPath, onEvent: (e: WatchEvent) => void, opts?: WatchOptions): Disposer
}
