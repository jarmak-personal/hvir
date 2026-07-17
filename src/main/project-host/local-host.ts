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

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import chokidar from 'chokidar'

import { hostPath, LOCAL_HOST_ID } from '../../shared'
import type {
  DirEntry,
  ExecResult,
  FileType,
  HostId,
  HostConnectionState,
  HostWatchTier,
  HostPath,
  Stat,
  WatchEvent,
  WatchEventType,
} from '../../shared'
import type {
  Disposer,
  ExecOptions,
  ExecStreamHandle,
  ProjectHost,
  PtyExit,
  PtyProcess,
  ReadFileOptions,
  SpawnPtyOptions,
  WatchOptions,
  WriteFileOptions,
} from './project-host'
import { MAX_EXEC_STREAM_WRITE_BYTES } from './project-host'

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10 MiB

export class LocalHost implements ProjectHost {
  readonly hostId: HostId = LOCAL_HOST_ID
  readonly connectionState: HostConnectionState = 'connected'
  readonly watchTier: HostWatchTier = 'native'

  /** Live watcher lifecycles, including any native-to-polling fallback. */
  private readonly watchers = new Set<Disposer>()

  connect(): Promise<void> {
    return Promise.resolve()
  }

  onConnectionState(cb: (state: HostConnectionState) => void): Disposer {
    cb(this.connectionState)
    return () => undefined
  }

  async dispose(): Promise<void> {
    const closing = [...this.watchers].map((stop) => stop())
    this.watchers.clear()
    await Promise.all(closing.map((result) => Promise.resolve(result)))
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
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: opts.cwd ? this.resolve(opts.cwd) : undefined,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        signal: opts.signal,
      })
      const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let stdoutNulRecords = 0
      let settled = false
      let truncated = false
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')

      const overflow = (): boolean => {
        if (
          bytes <= maxBuffer &&
          (opts.maxStdoutNulRecords === undefined ||
            stdoutNulRecords < opts.maxStdoutNulRecords)
        )
          return false
        if (opts.allowTruncatedOutput) {
          truncated = true
          child.kill()
          return true
        }
        settled = true
        child.kill()
        reject(new Error(`exec output exceeded maxBuffer (${maxBuffer} bytes)`))
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
          reject(err)
        }
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
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
    const child = spawn(command, [...args], {
      cwd: opts.cwd ? this.resolve(opts.cwd) : undefined,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
    const proc = pty.spawn(opts.file, [...(opts.args ?? [])], {
      cwd: this.resolve(opts.cwd),
      env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
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

  async readFile(path: HostPath, _opts: ReadFileOptions = {}): Promise<Buffer> {
    return fsp.readFile(this.resolve(path))
  }

  async readTextFile(
    path: HostPath,
    encoding: BufferEncoding = 'utf8',
    _opts: ReadFileOptions = {},
  ): Promise<string> {
    return fsp.readFile(this.resolve(path), encoding)
  }

  async writeFile(
    path: HostPath,
    data: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
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
      await fsp.writeFile(temporary, data, mode === undefined ? {} : { mode })
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
    if (p.hostId !== this.hostId) {
      throw new Error(
        `LocalHost received a path for host '${p.hostId}' (expected '${this.hostId}')`,
      )
    }
    return p.path
  }

  /** Re-qualify a raw local path back into a HostPath. */
  private wrap(rawPath: string): HostPath {
    return hostPath(this.hostId, rawPath)
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function fileChangedError(): Error {
  return new Error('File changed since it was opened; reload before saving')
}

function watchCapacityError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EMFILE' || code === 'ENOSPC'
}
