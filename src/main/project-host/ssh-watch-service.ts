import {
  hostPath,
  type HostConnectionState,
  type HostId,
  type HostPath,
  type HostWatchTier,
  type WatchEvent,
  type WatchEventType,
} from '../../shared'
import type { Disposer, ExecStreamHandle, WatchOptions } from './project-host'
import {
  fileType,
  metadataStamp,
  remoteChild,
  sftpLstat,
  sftpReaddir,
  type SshFileAccess,
} from './ssh-file-access'

const GIT_PRIORITY_FILES = new Set(['HEAD', 'index', 'packed-refs'])

export interface SshWatchOptions {
  readonly pollIntervalMs?: number
  readonly watchdogIntervalMs?: number
  readonly refreshPulseIntervalMs?: number
  readonly slowScanIntervalMs?: number
  readonly maxSlowScanIntervalMs?: number
  readonly pollDirectoryBatchSize?: number
}

export interface SshWatchOwner {
  readonly hostId: HostId
  connectionState(): HostConnectionState
  watchTier(): HostWatchTier
  setWatchTier(tier: HostWatchTier): void
  onConnectionState(cb: (state: HostConnectionState) => void): Disposer
  execStream(command: string, args: readonly string[]): ExecStreamHandle
}

/** Connection-aware inotify/polling orchestration for one logical SshHost. */
export class SshWatchService {
  constructor(
    private readonly owner: SshWatchOwner,
    private readonly files: SshFileAccess,
    private readonly options: SshWatchOptions,
  ) {}

  watch(
    path: HostPath,
    onEvent: (event: WatchEvent) => void,
    opts: WatchOptions = {},
  ): Disposer {
    this.files.assertPath(path)
    if ((opts.additionalPaths?.length ?? 0) > 256) {
      throw new Error('Too many additional watch paths')
    }
    for (const candidate of opts.additionalPaths ?? []) this.files.assertPath(candidate)
    const watchedPaths = [path, ...(opts.additionalPaths ?? [])].filter(
      (candidate, index, values) =>
        values.findIndex((value) => value.path === candidate.path) === index,
    )
    let stopped = false
    let stopBackend: Disposer | undefined
    const start = (): void => {
      if (stopped || stopBackend || this.owner.connectionState() !== 'connected') return
      const stopWatch =
        this.owner.watchTier() === 'inotify'
          ? this.watchInotify(path, onEvent, opts)
          : this.watchPolling(path, onEvent, opts)
      const pulseIntervalMs =
        this.options.refreshPulseIntervalMs ?? this.options.pollIntervalMs ?? 2_000
      let pulseTimer: ReturnType<typeof setTimeout> | undefined
      const pulse = (): void => {
        if (stopped || this.owner.connectionState() !== 'connected') return
        for (const watchedPath of watchedPaths) {
          this.files.invalidate(watchedPath.path)
          onEvent({ type: 'change', path: watchedPath, synthetic: 'refresh' })
        }
        pulseTimer = setTimeout(pulse, pulseIntervalMs)
      }
      pulseTimer = setTimeout(pulse, pulseIntervalMs)
      stopBackend = () => {
        if (pulseTimer) clearTimeout(pulseTimer)
        return stopWatch()
      }
    }
    const stopState = this.owner.onConnectionState((state) => {
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

  private watchInotify(
    path: HostPath,
    onEvent: (event: WatchEvent) => void,
    opts: WatchOptions,
  ): Disposer {
    let stopped = false
    const args = ['-m', '-e', 'modify,create,delete,move', '--format', '%e|%w%f']
    if (opts.recursive !== false) args.push('-r')
    if (opts.excludeDirectoryNames?.length) {
      const names = opts.excludeDirectoryNames.map(escapeRegex).join('|')
      args.push('--exclude', `(^|/)(${names})(/|$)`)
    }
    args.push(
      path.path,
      ...(opts.additionalPaths ?? []).map((candidate) => candidate.path),
    )
    const handle = this.owner.execStream('inotifywait', args)
    let pending = ''
    handle.onStdout((chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const at = line.indexOf('|')
        if (at < 0) continue
        const flags = line.slice(0, at)
        const changed = line.slice(at + 1)
        this.files.invalidate(changed)
        onEvent({
          type: inotifyEventType(flags),
          path: hostPath(this.owner.hostId, changed),
        })
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
      void handle.dispose()
      void watchdogStop?.()
      watchdogStop = undefined
      this.owner.setWatchTier('polling')
      pollingStop = this.watchPolling(path, onEvent, opts)
      fallingBack = false
    }
    handle.onError((error) => fallback(error))
    handle.onExit(({ code }) => {
      if (!stopped) fallback(new Error(`inotifywait exited (${String(code)})`))
    })
    return () => {
      stopped = true
      void handle.dispose()
      void watchdogStop?.()
      void pollingStop?.()
    }
  }

  private watchPolling(
    path: HostPath,
    onEvent: (event: WatchEvent) => void,
    opts: WatchOptions,
    requestedIntervalMs?: number,
  ): Disposer {
    let stopped = false
    let priorityInitialized = false
    let previousPriority = new Map<string, string>()
    let slowInitialized = false
    let previousSlow = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let retryMs = requestedIntervalMs ?? this.options.pollIntervalMs ?? 2_000
    let lastError: string | undefined
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
        this.files.invalidate(file)
        onEvent({
          type: previous.has(file)
            ? 'change'
            : stamp.startsWith('dir:')
              ? 'addDir'
              : 'add',
          path: hostPath(this.owner.hostId, file),
        })
      }
      for (const [file, stamp] of previous) {
        if (current.has(file)) continue
        changed = true
        this.files.forgetFingerprint(file)
        this.files.invalidate(file)
        onEvent({
          type: stamp.startsWith('dir:') ? 'unlinkDir' : 'unlink',
          path: hostPath(this.owner.hostId, file),
        })
      }
      return changed
    }
    const poll = async (): Promise<void> => {
      try {
        const current = await this.pollPrioritySnapshot(path, opts)
        if (stopped) return
        if (!priorityInitialized) {
          this.files.invalidate(path.path)
          onEvent({ type: 'change', path, synthetic: 'refresh' })
        }
        emitChanges(previousPriority, current, priorityInitialized)
        previousPriority = current
        priorityInitialized = true
        retryMs = intervalMs
        lastError = undefined

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
              for (const file of current.keys()) slowSnapshot.delete(file)
              for (const file of this.files.pollingInterests()) {
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
      } catch (reason) {
        if (stopped) return
        const error = asError(reason)
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
    const sftp = await this.files.getSftp()
    const result = new Map<string, string>()
    const roots = [root, ...(opts.additionalPaths ?? [])].filter(
      (candidate, index, values) =>
        values.findIndex((value) => value.path === candidate.path) === index,
    )
    for (const watchedRoot of roots) {
      let rootAttrs: import('ssh2').Attributes
      try {
        rootAttrs = await sftpLstat(sftp, watchedRoot.path)
      } catch (reason) {
        if (!isNoSuchFile(reason)) throw reason
        continue
      }
      if (fileType(rootAttrs.mode) !== 'dir') {
        result.set(
          watchedRoot.path,
          await this.files.pollStamp(
            sftp,
            watchedRoot.path,
            rootAttrs,
            this.files.pollingInterests().has(watchedRoot.path),
          ),
        )
        continue
      }

      const entries = await sftpReaddir(sftp, watchedRoot.path)
      const entryNames = new Set(entries.map((entry) => entry.filename))
      const gitMetadataDirectory =
        opts.recursive === false &&
        entryNames.has('HEAD') &&
        (entryNames.has('index') ||
          entryNames.has('objects') ||
          entryNames.has('commondir'))
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue
        const child = remoteChild(watchedRoot.path, entry.filename)
        const fingerprint =
          this.files.pollingInterests().has(child) ||
          (gitMetadataDirectory && GIT_PRIORITY_FILES.has(entry.filename))
        result.set(
          child,
          await this.files.pollStamp(sftp, child, entry.attrs, fingerprint),
        )
      }
    }

    if (opts.recursive !== false) {
      const prefix = root.path === '/' ? '/' : `${root.path}/`
      for (const file of this.files.pollingInterests()) {
        if (!file.startsWith(prefix) || result.has(file)) continue
        try {
          const attrs = await sftpLstat(sftp, file)
          result.set(file, await this.files.pollStamp(sftp, file, attrs, true))
        } catch (reason) {
          if (!isNoSuchFile(reason)) throw reason
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
    const sftp = await this.files.getSftp()
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
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function isNoSuchFile(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
