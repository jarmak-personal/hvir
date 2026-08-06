/**
 * `LocalHost` — the default `ProjectHost` (ADR-010).
 *
 * This is the ONLY module permitted to import node's fs / child_process and the
 * native modules chokidar and node-pty (enforced by lint). Everything else in
 * hvir reaches the local filesystem, processes, and PTYs through this seam, so
 * the day `SshHost` arrives nothing above the seam changes.
 *
 * node-pty is imported lazily inside `spawnPty` so the native binary is only
 * loaded when a PTY is actually spawned — keeping `dev` and unit tests from
 * needing an Electron-ABI rebuild before Phase 2.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, realpathSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { basename, dirname, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { getSystemErrorName } from 'node:util'
import chokidar from 'chokidar'

import {
  assertProjectHostTextPrefixByteLimit,
  boundTextWorkload,
  hostPath,
  LOCAL_HOST_ID,
  type TextWorkload,
} from '../../shared'
import type {
  DirEntry,
  ExecResult,
  FileType,
  HostId,
  HostConnectionState,
  HostWatchTier,
  HostPath,
  LoopbackEndpoint,
  Stat,
  WatchEvent,
  WatchEventType,
} from '../../shared'
import type {
  Disposer,
  ExclusiveCreateOptions,
  ExecOptions,
  ExecStreamHandle,
  ProjectHost,
  ProjectFileMetadataOptions,
  ProjectFileRenameOptions,
  ProjectFileDeletionPort,
  ProjectFileStreamOptions,
  ProjectFileTrashOptions,
  ProjectFileTransferPort,
  ProjectFileWriteStreamOptions,
  PtyExit,
  PtyProcess,
  ReadFileOptions,
  RemoveFileOptions,
  SpawnPtyOptions,
  WatchOptions,
  WriteFileOptions,
} from './project-host'
import {
  assertLoopbackEndpoint,
  MAX_EXEC_STREAM_WRITE_BYTES,
  ProjectPathExistsError,
  PROJECT_FILE_STREAM_CHUNK_BYTES,
} from './project-host'

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10 MiB
const ATOMIC_RENAME_HELPER_VERSION = '0.1.0'
const ATOMIC_RENAME_HELPER_PACKAGE = '@hvir/rename-noreplace'
const atomicRenameRequire = createRequire(import.meta.url)

interface AtomicRenameBinding {
  metadata(): unknown
  renameNoReplace(
    sourceParentFd: number,
    source: string,
    destinationParentFd: number,
    destination: string,
  ): unknown
}

export class LocalHost implements ProjectHost {
  readonly hostId: HostId = LOCAL_HOST_ID
  readonly connectionState: HostConnectionState = 'connected'
  readonly watchTier: HostWatchTier = 'native'
  readonly fileTransfer: ProjectFileTransferPort = {
    readFileChunks: (path, opts) => this.readFileChunks(path, opts),
    writeFileChunksExclusive: (path, chunks, opts) =>
      this.writeFileChunksExclusive(path, chunks, opts),
    setMetadata: (path, opts) => this.setProjectFileMetadata(path, opts),
    renameNoReplace: (source, destination, opts) =>
      this.renameProjectFileNoReplace(source, destination, opts),
    removeDirectory: (path, opts) => this.removeDirectory(path, opts),
  }
  readonly fileDeletion: ProjectFileDeletionPort

  /** Live watcher lifecycles, including any native-to-polling fallback. */
  private readonly watchers = new Set<Disposer>()
  /** Buffered commands owned until their process and pipes have closed. */
  private readonly bufferedExecs = new Set<Disposer>()

  /** Prepare one host-qualified local root during synchronous application bootstrap. */
  static ensureBootstrapDirectory(path: HostPath): void {
    mkdirSync(resolveHostPath(path, LOCAL_HOST_ID), { recursive: true })
  }

  constructor(
    private readonly options: {
      readonly trashItem?: (path: HostPath) => Promise<void>
    } = {},
  ) {
    this.fileDeletion = options.trashItem
      ? {
          capability: 'recoverable',
          trashEntry: (path, trashOptions) => this.trashEntry(path, trashOptions),
        }
      : { capability: 'unavailable' }
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  onConnectionState(cb: (state: HostConnectionState) => void): Disposer {
    cb(this.connectionState)
    return () => undefined
  }

  async dispose(): Promise<void> {
    const stopping = [...this.bufferedExecs].map((stop) => stop())
    this.bufferedExecs.clear()
    const closing = [...this.watchers].map((stop) => stop())
    this.watchers.clear()
    await Promise.all([...stopping, ...closing].map((result) => Promise.resolve(result)))
  }

  defaultShell(): Promise<string> {
    return Promise.resolve(
      process.env.SHELL ??
        (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
    )
  }

  exec(
    command: string,
    args: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const environment = childEnvironment(opts.env, opts.unsetEnv)
    return new Promise<ExecResult>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(execAbortError(opts.signal))
        return
      }
      const child = spawn(command, [...args], {
        cwd: opts.cwd ? this.resolve(opts.cwd) : undefined,
        env: environment,
        // Buffered commands never own a terminal. Give each POSIX command its
        // own session so login-interactive shells and terminal job-control
        // signals cannot stop Electron's process group with them.
        detached: process.platform !== 'win32',
      })
      const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let stdoutNulRecords = 0
      let settled = false
      let truncated = false
      let terminalError: Error | undefined
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')

      const terminate = (): void => {
        try {
          terminateBufferedExec(child)
        } catch (reason) {
          terminalError ??= asError(reason)
          child.kill('SIGKILL')
        }
      }
      let resolveClosed = (): void => undefined
      const closed = new Promise<void>((resolveClose) => {
        resolveClosed = resolveClose
      })
      const stop: Disposer = () => {
        if (!settled && !terminalError && !truncated) {
          terminalError = new Error('Local host disposed during buffered exec')
          terminate()
        }
        return closed
      }
      const abort = (): void => {
        if (terminalError || truncated || settled) return
        terminalError = execAbortError(opts.signal!)
        terminate()
      }
      const finish = (): void => {
        this.bufferedExecs.delete(stop)
        opts.signal?.removeEventListener('abort', abort)
        resolveClosed()
      }
      this.bufferedExecs.add(stop)
      opts.signal?.addEventListener('abort', abort, { once: true })

      const overflow = (): boolean => {
        if (
          bytes <= maxBuffer &&
          (opts.maxStdoutNulRecords === undefined ||
            stdoutNulRecords < opts.maxStdoutNulRecords)
        )
          return false
        if (opts.allowTruncatedOutput) {
          truncated = true
          terminate()
          return true
        }
        terminalError = new Error(`exec output exceeded maxBuffer (${maxBuffer} bytes)`)
        terminate()
        return true
      }

      child.stdout.on('data', (d: Buffer) => {
        if (truncated) return
        bytes += d.length
        if (opts.maxStdoutNulRecords !== undefined) {
          for (const byte of d) if (byte === 0) stdoutNulRecords++
        }
        stdout += stdoutDecoder.write(d)
        overflow()
      })
      child.stderr.on('data', (d: Buffer) => {
        if (truncated) return
        bytes += d.length
        stderr += stderrDecoder.write(d)
        overflow()
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          finish()
          reject(err)
        }
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        finish()
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        if (terminalError) {
          reject(terminalError)
          return
        }
        resolve({
          code,
          signal: signal ?? null,
          stdout,
          stderr,
          ...(truncated ? { outputTruncated: true } : {}),
        })
      })

      // Buffered exec has no writable stdin handle, so always close it. Leaving
      // it open makes commands that read until EOF (for example `cat`) hang.
      child.stdin.end(opts.input)
    })
  }

  execStream(
    command: string,
    args: readonly string[],
    opts: ExecOptions = {},
  ): ExecStreamHandle {
    const environment = childEnvironment(opts.env, opts.unsetEnv)
    const child = spawn(command, [...args], {
      cwd: opts.cwd ? this.resolve(opts.cwd) : undefined,
      env: environment,
      signal: opts.signal,
    })
    const errorListeners = new Set<(error: Error) => void>()
    const stdoutListeners = new Set<(value: string) => void>()
    const stderrListeners = new Set<(value: string) => void>()
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdinOpen = opts.keepStdinOpen === true
    let disposed = false
    const onError = (error: Error): void => {
      for (const cb of errorListeners) cb(error)
    }
    // Install immediately: a failed spawn emits `error` before a caller has a
    // chance to subscribe, and an unhandled child-process error crashes Node.
    child.on('error', onError)
    child.stdout.on('data', (chunk: Buffer) => {
      const value = stdoutDecoder.write(chunk)
      if (value) for (const cb of stdoutListeners) cb(value)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const value = stderrDecoder.write(chunk)
      if (value) for (const cb of stderrListeners) cb(value)
    })
    child.on('close', () => {
      stdinOpen = false
      const stdout = stdoutDecoder.end()
      const stderr = stderrDecoder.end()
      if (stdout) for (const cb of stdoutListeners) cb(stdout)
      if (stderr) for (const cb of stderrListeners) cb(stderr)
    })

    if (stdinOpen) {
      if (opts.input !== undefined) child.stdin.write(opts.input)
    } else {
      child.stdin.end(opts.input)
    }

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
    const performStdinWrite = (operation: (done: () => void) => void): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onStdinError = (error: Error): void => {
          child.stdin.off('error', onStdinError)
          reject(error)
        }
        child.stdin.once('error', onStdinError)
        operation(() => {
          child.stdin.off('error', onStdinError)
          resolve()
        })
      })

    return {
      onStdout(cb) {
        stdoutListeners.add(cb)
        return () => {
          stdoutListeners.delete(cb)
        }
      },
      onStderr(cb) {
        stderrListeners.add(cb)
        return () => {
          stderrListeners.delete(cb)
        }
      },
      onError(cb) {
        errorListeners.add(cb)
        return () => {
          errorListeners.delete(cb)
        }
      },
      onExit(cb) {
        const h = (code: number | null, signal: NodeJS.Signals | null): void =>
          cb({ code, signal: signal ?? null })
        child.on('close', h)
        return () => {
          child.off('close', h)
        }
      },
      write(data) {
        try {
          writableStdin(data)
        } catch (error) {
          return Promise.reject(asError(error))
        }
        return performStdinWrite((done) => child.stdin.write(data, done))
      },
      end(data) {
        try {
          writableStdin(data)
        } catch (error) {
          return Promise.reject(asError(error))
        }
        stdinOpen = false
        return performStdinWrite((done) => child.stdin.end(data, done))
      },
      kill(signal) {
        child.kill(signal as NodeJS.Signals | undefined)
      },
      dispose() {
        disposed = true
        stdinOpen = false
        errorListeners.clear()
        stdoutListeners.clear()
        stderrListeners.clear()
        child.stdout.removeAllListeners()
        child.stderr.removeAllListeners()
        child.removeAllListeners()
        if (child.exitCode === null) child.kill()
      },
    }
  }

  async spawnPty(opts: SpawnPtyOptions): Promise<PtyProcess> {
    // Lazy native import — see file header.
    const pty = await import('node-pty')
    const env = childEnvironment(opts.env, opts.unsetEnv)
    const proc = pty.spawn(opts.file, [...(opts.args ?? [])], {
      cwd: this.resolve(opts.cwd),
      env,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      name: opts.name ?? 'xterm-256color',
    })

    return {
      get pid() {
        return proc.pid
      },
      onData(cb) {
        const sub = proc.onData(cb)
        return () => sub.dispose()
      },
      onExit(cb) {
        const sub = proc.onExit((e: { exitCode: number; signal?: number }): void => {
          const exit: PtyExit = { exitCode: e.exitCode, signal: e.signal }
          cb(exit)
        })
        return () => sub.dispose()
      },
      write(data) {
        proc.write(data)
      },
      resize(cols, rows) {
        proc.resize(cols, rows)
      },
      kill(signal) {
        proc.kill(signal)
      },
    }
  }

  connectLoopback(endpoint: LoopbackEndpoint): Promise<import('node:stream').Duplex> {
    assertLoopbackEndpoint(endpoint)
    return new Promise((resolve, reject) => {
      const socket = connect({ host: endpoint.hostname, port: endpoint.port })
      const fail = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.removeListener('error', fail)
        resolve(socket)
      })
    })
  }

  async readFile(path: HostPath, opts: ReadFileOptions = {}): Promise<Buffer> {
    return fsp.readFile(this.resolve(path), { signal: opts.signal })
  }

  async readTextFile(
    path: HostPath,
    encoding: BufferEncoding = 'utf8',
    opts: ReadFileOptions = {},
  ): Promise<string> {
    return fsp.readFile(this.resolve(path), { encoding, signal: opts.signal })
  }

  async readTextFilePrefix(
    path: HostPath,
    maxBytes: number,
    opts: ReadFileOptions = {},
  ): Promise<TextWorkload> {
    assertProjectHostTextPrefixByteLimit(maxBytes)
    opts.signal?.throwIfAborted()
    const handle = await fsp.open(this.resolve(path), 'r')
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    try {
      while (offset < buffer.byteLength) {
        opts.signal?.throwIfAborted()
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        )
        if (bytesRead === 0) break
        offset += bytesRead
      }
    } finally {
      await handle.close()
    }
    opts.signal?.throwIfAborted()
    const bytes = buffer.subarray(0, offset)
    return {
      ...boundTextWorkload(bytes.toString('utf8'), maxBytes, offset <= maxBytes),
      validUtf8: isUtf8(bytes),
    }
  }

  async writeFile(
    path: HostPath,
    data: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    opts.signal?.throwIfAborted()
    const destination = this.resolve(path)
    let mode: number | undefined
    try {
      mode = (await fsp.lstat(destination)).mode & 0o777
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
      if (opts.expectedMtimeMs !== undefined) throw fileChangedError()
    }
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.hvir-${randomUUID()}.tmp`,
    )
    try {
      await fsp.writeFile(temporary, data, {
        ...(mode === undefined ? {} : { mode }),
        signal: opts.signal,
      })
      opts.signal?.throwIfAborted()
      if (opts.expectedMtimeMs !== undefined) {
        const current = await fsp.lstat(destination)
        if (current.mtimeMs !== opts.expectedMtimeMs) throw fileChangedError()
      }
      await fsp.rename(temporary, destination)
    } catch (reason) {
      await fsp.unlink(temporary).catch(() => undefined)
      throw reason
    }
  }

  async createFileExclusive(path: HostPath, opts: ExclusiveCreateOptions): Promise<void> {
    opts.signal?.throwIfAborted()
    const destination = this.resolve(path)
    let created = false
    let handle: import('node:fs/promises').FileHandle | undefined
    try {
      handle = await fsp.open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        opts.mode,
      )
      created = true
      opts.onCreated?.()
      opts.signal?.throwIfAborted()
      await handle.chmod(opts.mode)
      await handle.close()
      handle = undefined
      opts.signal?.throwIfAborted()
    } catch (reason) {
      await handle?.close().catch(() => undefined)
      if (created) await fsp.unlink(destination).catch(() => undefined)
      if ((reason as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectPathExistsError()
      }
      throw reason
    }
  }

  async createDirectoryExclusive(
    path: HostPath,
    opts: ExclusiveCreateOptions,
  ): Promise<void> {
    opts.signal?.throwIfAborted()
    const destination = this.resolve(path)
    let created = false
    try {
      await fsp.mkdir(destination, { mode: opts.mode })
      created = true
      opts.onCreated?.()
      opts.signal?.throwIfAborted()
      await fsp.chmod(destination, opts.mode)
      opts.signal?.throwIfAborted()
    } catch (reason) {
      if (created) await fsp.rmdir(destination).catch(() => undefined)
      if ((reason as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectPathExistsError()
      }
      throw reason
    }
  }

  private async *readFileChunks(
    path: HostPath,
    opts: ProjectFileStreamOptions = {},
  ): AsyncIterable<Uint8Array> {
    opts.signal?.throwIfAborted()
    const handle = await fsp.open(this.resolve(path), 'r')
    const buffer = Buffer.allocUnsafe(PROJECT_FILE_STREAM_CHUNK_BYTES)
    try {
      for (;;) {
        opts.signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
        if (bytesRead === 0) return
        yield Buffer.from(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  }

  private async writeFileChunksExclusive(
    path: HostPath,
    chunks: AsyncIterable<Uint8Array>,
    opts: ProjectFileWriteStreamOptions,
  ): Promise<void> {
    opts.signal?.throwIfAborted()
    const destination = this.resolve(path)
    let created = false
    let handle: import('node:fs/promises').FileHandle | undefined
    try {
      handle = await fsp.open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        opts.mode,
      )
      created = true
      opts.onCreated?.()
      for await (const chunk of chunks) {
        opts.signal?.throwIfAborted()
        const value = Buffer.from(chunk)
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.byteLength - offset,
            null,
          )
          if (bytesWritten <= 0) throw new Error('Local file stream made no progress')
          offset += bytesWritten
        }
      }
      opts.signal?.throwIfAborted()
      await handle.chmod(opts.mode)
      await handle.close()
      handle = undefined
    } catch (reason) {
      await handle?.close().catch(() => undefined)
      if (created) await fsp.unlink(destination).catch(() => undefined)
      if ((reason as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectPathExistsError()
      }
      throw reason
    }
  }

  private async setProjectFileMetadata(
    path: HostPath,
    opts: ProjectFileMetadataOptions,
  ): Promise<void> {
    opts.signal?.throwIfAborted()
    const target = this.resolve(path)
    await fsp.chmod(target, opts.mode)
    opts.signal?.throwIfAborted()
    await fsp.utimes(target, opts.mtimeSeconds, opts.mtimeSeconds)
    opts.signal?.throwIfAborted()
  }

  private async renameProjectFileNoReplace(
    source: HostPath,
    destination: HostPath,
    opts: ProjectFileRenameOptions = {},
  ): Promise<void> {
    opts.signal?.throwIfAborted()
    const from = this.resolve(source)
    const to = this.resolve(destination)
    const sourceParent = await fsp.open(dirname(from), 'r')
    let destinationParent: Awaited<ReturnType<typeof fsp.open>> | undefined
    let operationFailed = false
    let operationReason: unknown
    try {
      destinationParent =
        dirname(from) === dirname(to) ? sourceParent : await fsp.open(dirname(to), 'r')
      opts.signal?.throwIfAborted()
      const binding = loadAtomicRenameBinding()
      const sourceName = basename(from)
      const destinationName = basename(to)
      opts.onSubmitted?.()
      const result = binding.renameNoReplace(
        sourceParent.fd,
        sourceName,
        destinationParent.fd,
        destinationName,
      )
      if (!Number.isInteger(result) || (result as number) < 0) {
        throw new Error('Atomic no-replace helper returned an invalid result')
      }
      if (result !== 0) throw atomicRenameError(result as number)
    } catch (reason) {
      operationFailed = true
      operationReason = reason
    } finally {
      if (destinationParent && destinationParent !== sourceParent) {
        await destinationParent.close().catch(() => undefined)
      }
      await sourceParent.close().catch(() => undefined)
    }
    if (operationFailed) throw operationReason
  }

  private async removeDirectory(
    path: HostPath,
    opts: { readonly ignoreMissing?: boolean } = {},
  ): Promise<void> {
    try {
      await fsp.rmdir(this.resolve(path))
    } catch (reason) {
      if (!opts.ignoreMissing || (reason as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw reason
      }
    }
  }

  private async trashEntry(
    path: HostPath,
    opts: ProjectFileTrashOptions = {},
  ): Promise<void> {
    this.resolve(path)
    opts.signal?.throwIfAborted()
    opts.onSubmitted?.()
    await this.options.trashItem!(path)
  }

  async removeFile(path: HostPath, opts: RemoveFileOptions = {}): Promise<void> {
    const destination = this.resolve(path)
    if (opts.expectedMtimeMs !== undefined) {
      let current: import('node:fs').Stats
      try {
        current = await fsp.lstat(destination)
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === 'ENOENT') throw fileChangedError()
        throw reason
      }
      if (current.mtimeMs !== opts.expectedMtimeMs) throw fileChangedError()
    }
    try {
      await fsp.unlink(destination)
    } catch (reason) {
      if (!opts.ignoreMissing || (reason as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw reason
      }
    }
  }

  async readdir(path: HostPath): Promise<DirEntry[]> {
    const entries = await fsp.readdir(this.resolve(path), { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory()
        ? 'dir'
        : e.isSymbolicLink()
          ? 'symlink'
          : e.isFile()
            ? 'file'
            : 'other',
    }))
  }

  async stat(path: HostPath): Promise<Stat> {
    // lstat preserves the distinction promised by Stat.type; stat() follows a
    // symlink and makes the `symlink` branch unreachable.
    const s = await fsp.lstat(this.resolve(path))
    let type: FileType = 'other'
    if (s.isDirectory()) type = 'dir'
    else if (s.isFile()) type = 'file'
    else if (s.isSymbolicLink()) type = 'symlink'
    return { type, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode }
  }

  async realpath(path: HostPath): Promise<HostPath> {
    return this.wrap(await fsp.realpath(this.resolve(path)))
  }

  watch(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions = {},
  ): Disposer {
    if ((opts.additionalPaths?.length ?? 0) > 256) {
      throw new Error('Too many additional watch paths')
    }
    const root = realpathSync.native(this.resolve(path))
    const roots = [
      root,
      ...(opts.additionalPaths ?? []).flatMap((candidate) => {
        try {
          return [realpathSync.native(this.resolve(candidate))]
        } catch {
          // An expanded directory can disappear between renderer interest and
          // watcher replacement. Its parent watch will report that removal.
          return []
        }
      }),
    ].filter((candidate, index, values) => values.indexOf(candidate) === index)
    const excludedNames = new Set(opts.excludeDirectoryNames ?? [])
    let active: import('chokidar').FSWatcher | undefined
    let fallback: Promise<void> | undefined
    let fallingBack = false
    let stopped = false

    const emit =
      (type: WatchEventType) =>
      (absPath: string): void =>
        onEvent({ type, path: this.wrap(absPath) })

    const start = (usePolling: boolean): import('chokidar').FSWatcher => {
      const watcher = chokidar.watch(roots, {
        ignoreInitial: true,
        usePolling,
        depth: opts.recursive === false ? 0 : undefined,
        ignored:
          excludedNames.size === 0
            ? undefined
            : (candidate) =>
                roots.some((watchedRoot) => {
                  const within = relative(watchedRoot, candidate)
                  return (
                    within !== '..' &&
                    !within.startsWith(`..${sep}`) &&
                    within.split(sep).some((part) => excludedNames.has(part))
                  )
                }),
      })
      watcher
        .on('add', emit('add'))
        .on('change', emit('change'))
        .on('unlink', emit('unlink'))
        .on('addDir', emit('addDir'))
        .on('unlinkDir', emit('unlinkDir'))
        .on('error', (reason) => {
          const error = reason instanceof Error ? reason : new Error(String(reason))
          if (!usePolling && !fallingBack && !stopped && watchCapacityError(error)) {
            fallingBack = true
            if (active === watcher) active = undefined
            fallback = watcher.close().then(
              () => {
                if (!stopped) active = start(true)
              },
              (closeReason: unknown) => {
                opts.onError?.(
                  closeReason instanceof Error
                    ? closeReason
                    : new Error(String(closeReason)),
                )
              },
            )
            return
          }
          opts.onError?.(error)
        })
      return watcher
    }

    const stop: Disposer = async () => {
      if (stopped) return
      stopped = true
      this.watchers.delete(stop)
      const watcher = active
      active = undefined
      if (watcher) await watcher.close()
      if (fallback) await fallback
    }
    this.watchers.add(stop)
    active = start(false)
    return stop
  }

  /** Unwrap a same-host HostPath to a raw string, rejecting foreign hosts. */
  private resolve(p: HostPath): string {
    return resolveHostPath(p, this.hostId)
  }

  /** Re-qualify a raw local path back into a HostPath. */
  private wrap(rawPath: string): HostPath {
    return hostPath(this.hostId, rawPath)
  }
}

function resolveHostPath(path: HostPath, expectedHostId: HostId): string {
  if (path.hostId !== expectedHostId) {
    throw new Error(
      `LocalHost received a path for host '${path.hostId}' (expected '${expectedHostId}')`,
    )
  }
  return path.path
}

function childEnvironment(
  explicit: Readonly<Record<string, string>> | undefined,
  inheritedUnsets: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of inheritedUnsets ?? []) delete environment[name]
  return Object.assign(environment, explicit)
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function execAbortError(signal: AbortSignal): Error {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

function terminateBufferedExec(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' || child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ESRCH') throw reason
  }
}

function fileChangedError(): Error {
  return new Error('File changed since it was opened; reload before saving')
}

function loadAtomicRenameBinding(): AtomicRenameBinding {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Atomic no-replace publication is unavailable on this platform')
  }
  const manifest = atomicRenameRequire(
    `${ATOMIC_RENAME_HELPER_PACKAGE}/package.json`,
  ) as {
    name?: unknown
    version?: unknown
  }
  if (
    manifest.name !== ATOMIC_RENAME_HELPER_PACKAGE ||
    manifest.version !== ATOMIC_RENAME_HELPER_VERSION
  ) {
    throw new Error('Atomic no-replace helper metadata does not match hvir')
  }
  const candidate = atomicRenameRequire(
    ATOMIC_RENAME_HELPER_PACKAGE,
  ) as Partial<AtomicRenameBinding>
  if (
    typeof candidate.metadata !== 'function' ||
    typeof candidate.renameNoReplace !== 'function' ||
    candidate.metadata() !== 'hvir.rename-noreplace.v1'
  ) {
    throw new Error('Atomic no-replace helper exports do not match hvir')
  }
  return candidate as AtomicRenameBinding
}

function atomicRenameError(errno: number): Error {
  let code = 'UNKNOWN'
  try {
    code = getSystemErrorName(-errno)
  } catch {
    // Preserve a closed error when the platform reports an unknown errno.
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new ProjectPathExistsError()
  }
  return Object.assign(new Error(`Atomic no-replace publication failed with ${code}`), {
    code,
  })
}

function watchCapacityError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EMFILE' || code === 'ENOSPC'
}
