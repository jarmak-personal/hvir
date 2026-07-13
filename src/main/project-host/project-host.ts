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

export interface ExecOptions {
  readonly cwd?: HostPath
  readonly env?: Record<string, string>
  /** Written to the child's stdin, then stdin is closed. */
  readonly input?: string
  readonly signal?: AbortSignal
  /** Max bytes to buffer across stdout+stderr before failing. */
  readonly maxBuffer?: number
}

export interface ExecStreamHandle {
  onStdout(cb: (chunk: string) => void): Disposer
  onStderr(cb: (chunk: string) => void): Disposer
  onError(cb: (error: Error) => void): Disposer
  onExit(cb: (result: { code: number | null; signal: string | null }) => void): Disposer
  kill(signal?: string): void
  dispose(): void
}

export interface WatchOptions {
  readonly recursive?: boolean
  /** Directory basenames to prune entirely from a recursive watch. */
  readonly excludeDirectoryNames?: readonly string[]
  /** Watch backends report asynchronous failures here instead of throwing. */
  readonly onError?: (error: Error) => void
}

export interface SpawnPtyOptions {
  readonly file: string
  readonly args?: readonly string[]
  readonly cwd: HostPath
  readonly env?: Record<string, string>
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

  readFile(path: HostPath): Promise<Buffer>
  readTextFile(path: HostPath, encoding?: BufferEncoding): Promise<string>
  writeFile(path: HostPath, data: Uint8Array | string): Promise<void>
  readdir(path: HostPath): Promise<DirEntry[]>
  stat(path: HostPath): Promise<Stat>
  /** Canonicalize through symlinks on the project host. */
  realpath(path: HostPath): Promise<HostPath>

  /** Watch a path; returns a disposer that stops watching. */
  watch(path: HostPath, onEvent: (e: WatchEvent) => void, opts?: WatchOptions): Disposer
}
