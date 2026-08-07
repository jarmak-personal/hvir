/**
 * `ProjectHost` — the transport seam (ADR-010).
 *
 * Every filesystem, exec, PTY, and watch operation in hvir goes through a
 * `ProjectHost`. `LocalHost` is the default implementation; `SshHost` (Phase 4)
 * will implement the same interface over ssh2. Nothing above this seam knows or
 * cares whether a project is local or remote — remoteness is transport, not a
 * server. All paths are host-qualified `HostPath`s.
 */

import type { Duplex } from 'node:stream'

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
  LoopbackEndpoint,
  TextWorkload,
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
  /** Cancel an in-flight write without publishing its temporary file. */
  readonly signal?: AbortSignal
}

export type ProjectFileMode = 0o644 | 0o755

export const PROJECT_FILE_STREAM_CHUNK_BYTES = 64 * 1024

export interface ProjectFileStreamOptions {
  readonly signal?: AbortSignal
}

export interface ProjectFileWriteStreamOptions extends ProjectFileStreamOptions {
  readonly mode: ProjectFileMode
  /** Exact destination ownership begins immediately after exclusive creation. */
  readonly onCreated?: () => void
}

export interface ProjectFileMetadataOptions extends ProjectFileStreamOptions {
  readonly mode: ProjectFileMode
  readonly mtimeSeconds: number
}

export interface ProjectFileRenameOptions extends ProjectFileStreamOptions {
  /** The immediate no-replace primitive has been submitted and must finish truthfully. */
  readonly onSubmitted?: () => void
}

export interface ProjectFileTrashOptions extends ProjectFileStreamOptions {
  /** The immediate recoverable-trash primitive has been submitted. */
  readonly onSubmitted?: () => void
}

/** Truthful immediate deletion mechanics; recursive policy remains coordinator-owned. */
export type ProjectFileDeletionPort =
  | {
      readonly capability: 'recoverable'
      trashEntry(path: HostPath, opts?: ProjectFileTrashOptions): Promise<void>
    }
  | {
      readonly capability: 'permanent'
    }
  | {
      readonly capability: 'unavailable'
    }

/** Immediate transfer mechanics. Recursive policy remains coordinator-owned. */
export interface ProjectFileTransferPort {
  readFileChunks(
    path: HostPath,
    opts?: ProjectFileStreamOptions,
  ): AsyncIterable<Uint8Array>
  writeFileChunksExclusive(
    path: HostPath,
    chunks: AsyncIterable<Uint8Array>,
    opts: ProjectFileWriteStreamOptions,
  ): Promise<void>
  setMetadata(path: HostPath, opts: ProjectFileMetadataOptions): Promise<void>
  renameNoReplace(
    source: HostPath,
    destination: HostPath,
    opts?: ProjectFileRenameOptions,
  ): Promise<void>
  removeDirectory(
    path: HostPath,
    opts?: { readonly ignoreMissing?: boolean },
  ): Promise<void>
}

export interface ExclusiveCreateOptions {
  readonly mode: ProjectFileMode
  /** Reject before beginning the immediate exclusive filesystem effect. */
  readonly signal?: AbortSignal
  /** Exact destination ownership begins immediately after exclusive creation. */
  readonly onCreated?: () => void
}

export class ProjectPathExistsError extends Error {
  readonly code = 'EEXIST'

  constructor() {
    super('The destination already exists')
    this.name = 'ProjectPathExistsError'
  }
}

export function isProjectPathExistsError(reason: unknown): boolean {
  return (
    reason instanceof ProjectPathExistsError ||
    (typeof reason === 'object' &&
      reason !== null &&
      (reason as { code?: unknown }).code === 'EEXIST')
  )
}

export interface RemoveFileOptions {
  /** Reject if the live file no longer has the version originally read. */
  readonly expectedMtimeMs?: number
  /** Treat an already-absent removal target as a successful idempotent cleanup. */
  readonly ignoreMissing?: boolean
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

export function assertLoopbackEndpoint(endpoint: LoopbackEndpoint): void {
  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)
  ) {
    throw new Error('Invalid loopback endpoint')
  }
}

export interface ProjectHost {
  readonly hostId: HostId
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  /** Present when this host can participate in verified project-file transfers. */
  readonly fileTransfer?: ProjectFileTransferPort
  /** Exact recovery guarantee and immediate top-level trash mechanic, when available. */
  readonly fileDeletion: ProjectFileDeletionPort

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

  /** Open one bounded TCP stream to an exact loopback endpoint on this host. */
  connectLoopback(endpoint: LoopbackEndpoint): Promise<Duplex>

  readFile(path: HostPath, opts?: ReadFileOptions): Promise<Buffer>
  readTextFile(
    path: HostPath,
    encoding?: BufferEncoding,
    opts?: ReadFileOptions,
  ): Promise<string>
  /** Read at most `maxBytes` of UTF-8 text and disclose whether the file ended. */
  readTextFilePrefix(path: HostPath, maxBytes: number): Promise<TextWorkload>
  writeFile(
    path: HostPath,
    data: Uint8Array | string,
    opts?: WriteFileOptions,
  ): Promise<void>
  /** Create one zero-byte regular file without replacing an existing entry. */
  createFileExclusive(path: HostPath, opts: ExclusiveCreateOptions): Promise<void>
  /** Create one empty directory without replacing an existing entry. */
  createDirectoryExclusive(path: HostPath, opts: ExclusiveCreateOptions): Promise<void>
  /** Remove one file, optionally only while its observed version is still current. */
  removeFile(path: HostPath, opts?: RemoveFileOptions): Promise<void>
  readdir(path: HostPath): Promise<DirEntry[]>
  /** Inspect the entry itself without following symbolic links (local/SFTP lstat). */
  stat(path: HostPath): Promise<Stat>
  /** Canonicalize through symlinks on the project host. */
  realpath(path: HostPath): Promise<HostPath>

  /** Watch a path; returns a disposer that stops watching. */
  watch(path: HostPath, onEvent: (e: WatchEvent) => void, opts?: WatchOptions): Disposer
}
