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
import { promises as fsp } from 'node:fs'
import { relative, sep } from 'node:path'
import chokidar from 'chokidar'

import { hostPath, LOCAL_HOST_ID } from '../../shared'
import type {
  DirEntry,
  ExecResult,
  FileType,
  HostId,
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
  SpawnPtyOptions,
  WatchOptions,
} from './project-host'

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10 MiB

export class LocalHost implements ProjectHost {
  readonly hostId: HostId = LOCAL_HOST_ID

  /** Live watchers, closed on dispose(). */
  private readonly watchers = new Set<import('chokidar').FSWatcher>()

  connect(): Promise<void> {
    return Promise.resolve()
  }

  async dispose(): Promise<void> {
    const closing = [...this.watchers].map((w) => w.close())
    this.watchers.clear()
    await Promise.all(closing)
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
      let settled = false

      const overflow = (): boolean => {
        if (bytes <= maxBuffer) return false
        settled = true
        child.kill()
        reject(new Error(`exec output exceeded maxBuffer (${maxBuffer} bytes)`))
        return true
      }

      child.stdout.on('data', (d: Buffer) => {
        bytes += d.length
        stdout += d.toString('utf8')
        overflow()
      })
      child.stderr.on('data', (d: Buffer) => {
        bytes += d.length
        stderr += d.toString('utf8')
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
        resolve({ code, signal: signal ?? null, stdout, stderr })
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
    const onError = (error: Error): void => {
      for (const cb of errorListeners) cb(error)
    }
    // Install immediately: a failed spawn emits `error` before a caller has a
    // chance to subscribe, and an unhandled child-process error crashes Node.
    child.on('error', onError)

    // There is no streaming stdin writer in this Phase 1 seam, so EOF is the
    // only useful default when no fixed input was supplied.
    child.stdin.end(opts.input)

    return {
      onStdout(cb) {
        const h = (d: Buffer): void => cb(d.toString('utf8'))
        child.stdout.on('data', h)
        return () => {
          child.stdout.off('data', h)
        }
      },
      onStderr(cb) {
        const h = (d: Buffer): void => cb(d.toString('utf8'))
        child.stderr.on('data', h)
        return () => {
          child.stderr.off('data', h)
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
      kill(signal) {
        child.kill(signal as NodeJS.Signals | undefined)
      },
      dispose() {
        errorListeners.clear()
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

  async readFile(path: HostPath): Promise<Buffer> {
    return fsp.readFile(this.resolve(path))
  }

  async readTextFile(path: HostPath, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return fsp.readFile(this.resolve(path), encoding)
  }

  async writeFile(path: HostPath, data: Uint8Array | string): Promise<void> {
    await fsp.writeFile(this.resolve(path), data)
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

  watch(
    path: HostPath,
    onEvent: (e: WatchEvent) => void,
    opts: WatchOptions = {},
  ): Disposer {
    const root = this.resolve(path)
    const excludedNames = new Set(opts.excludeDirectoryNames ?? [])
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: opts.recursive === false ? 0 : undefined,
      ignored:
        excludedNames.size === 0
          ? undefined
          : (candidate) =>
              relative(root, candidate)
                .split(sep)
                .some((part) => excludedNames.has(part)),
    })

    const emit =
      (type: WatchEventType) =>
      (absPath: string): void =>
        onEvent({ type, path: this.wrap(absPath) })

    watcher
      .on('add', emit('add'))
      .on('change', emit('change'))
      .on('unlink', emit('unlink'))
      .on('addDir', emit('addDir'))
      .on('unlinkDir', emit('unlinkDir'))
      .on('error', (error) =>
        opts.onError?.(error instanceof Error ? error : new Error(String(error))),
      )

    this.watchers.add(watcher)
    return async () => {
      this.watchers.delete(watcher)
      await watcher.close()
    }
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
