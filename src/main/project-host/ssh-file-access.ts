import { createHash, randomUUID } from 'node:crypto'

import type { SFTPWrapper } from 'ssh2'

import {
  hostPath,
  type DirEntry,
  type FileType,
  type HostId,
  type HostPath,
  type Stat,
  type TextWorkload,
} from '../../shared'
import type {
  ExclusiveCreateOptions,
  ReadFileOptions,
  RemoveFileOptions,
  WriteFileOptions,
} from './project-host'
import { readSshTextPrefix } from './ssh-text-prefix'
import { SshExclusiveCreate } from './ssh-exclusive-create'

export interface SshFileAccessOptions {
  readonly fingerprintObservationWindowMs?: number
}

export interface SshFileAccessOwner {
  readonly hostId: HostId
  openSftp(): Promise<SFTPWrapper>
}

/** Transport-scoped SFTP/cache state plus content-scoped optimistic save authority. */
export class SshFileAccess {
  private readonly exclusiveCreate: SshExclusiveCreate
  private generation = 0
  private sftpSession?: Promise<SFTPWrapper>
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

  constructor(
    private readonly owner: SshFileAccessOwner,
    private readonly options: SshFileAccessOptions,
  ) {
    this.exclusiveCreate = new SshExclusiveCreate({
      hostId: owner.hostId,
      getSftp: () => this.getSftp(),
      lstat: (path) => this.lstat(path),
      invalidate: (path) => this.invalidate(path),
    })
  }

  advanceGeneration(): void {
    this.generation++
    const session = this.sftpSession
    this.sftpSession = undefined
    this.cache.clear()
    this.fingerprintObservations.clear()
    void session?.then(
      (value) => value.end(),
      () => undefined,
    )
  }

  dispose(): void {
    this.advanceGeneration()
    this.pollingFiles.clear()
    this.readDigests.clear()
  }

  async readFile(path: HostPath, opts: ReadFileOptions = {}): Promise<Buffer> {
    this.assertPath(path)
    if (opts.pollingInterest) this.pollingFiles.add(path.path)
    const key = `f:${path.path}`
    const cached = this.cached<Buffer>(key)
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

  async readTextFilePrefix(path: HostPath, maxBytes: number): Promise<TextWorkload> {
    this.assertPath(path)
    return readSshTextPrefix(await this.getSftp(), path.path, maxBytes)
  }

  async writeFile(
    path: HostPath,
    value: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    this.assertPath(path)
    opts.signal?.throwIfAborted()
    const data = Buffer.from(value)
    const parent = remoteParent(path.path)
    const basename = path.path.slice(parent === '/' ? 1 : parent.length + 1)
    const temporary = `${parent === '/' ? '' : parent}/.${basename}.hvir-${randomUUID()}.tmp`
    let mode: number | undefined
    try {
      const attrs = await this.sftp<import('ssh2').Stats>(
        (s, done) => s.lstat(path.path, done),
        opts.signal,
      )
      mode = attrs.mode & 0o777
    } catch (reason) {
      if (!isNoSuchFile(reason)) throw reason
    }
    const expectedDigest = this.readDigests.get(path.path)
    try {
      await this.sftp<void>((s, done) => {
        if (opts.signal) {
          writeSftpFile(s, temporary, data, mode, opts.signal, done)
        } else {
          s.writeFile(temporary, data, mode === undefined ? {} : { mode }, done)
        }
      })
      opts.signal?.throwIfAborted()
      if (opts.expectedMtimeMs !== undefined) {
        const currentAttrs = await this.sftp<import('ssh2').Stats>(
          (s, done) => s.lstat(path.path, done),
          opts.signal,
        )
        if (currentAttrs.mtime * 1_000 !== opts.expectedMtimeMs) {
          throw fileChangedError()
        }
      }
      if (expectedDigest !== undefined) {
        const current = await this.sftp<Buffer>(
          (s, done) => s.readFile(path.path, done),
          opts.signal,
        )
        if (contentDigest(current) !== expectedDigest) throw fileChangedError()
      }
      try {
        await this.sftp<void>(
          (s, done) => s.ext_openssh_rename(temporary, path.path, done),
          opts.signal,
        )
      } catch {
        opts.signal?.throwIfAborted()
        await this.sftp<void>(
          (s, done) => s.rename(temporary, path.path, done),
          opts.signal,
        )
      }
    } catch (reason) {
      await this.sftp<void>((s, done) => s.unlink(temporary, done)).catch(() => undefined)
      throw reason
    }
    this.readDigests.set(path.path, contentDigest(data))
    this.fingerprintObservations.delete(path.path)
    this.invalidate(path.path)
  }

  async createFileExclusive(path: HostPath, opts: ExclusiveCreateOptions): Promise<void> {
    return this.exclusiveCreate.file(path, opts)
  }

  async createDirectoryExclusive(
    path: HostPath,
    opts: ExclusiveCreateOptions,
  ): Promise<void> {
    return this.exclusiveCreate.directory(path, opts)
  }

  async removeFile(path: HostPath, opts: RemoveFileOptions = {}): Promise<void> {
    this.assertPath(path)
    if (opts.expectedMtimeMs !== undefined) {
      const current = await this.sftp<import('ssh2').Stats>((s, done) =>
        s.lstat(path.path, done),
      )
      if (current.mtime * 1_000 !== opts.expectedMtimeMs) throw fileChangedError()
    }
    try {
      await this.sftp<void>((s, done) => s.unlink(path.path, done))
    } catch (reason) {
      if (!opts.ignoreMissing || !isNoSuchFile(reason)) throw reason
    }
    this.pollingFiles.delete(path.path)
    this.readDigests.delete(path.path)
    this.fingerprintObservations.delete(path.path)
    this.invalidate(path.path)
  }

  async readdir(path: HostPath): Promise<DirEntry[]> {
    this.assertPath(path)
    const key = `d:${path.path}`
    const cached = this.cached<DirEntry[]>(key)
    if (cached) return [...cached]
    const raw = await this.sftp<import('ssh2').FileEntry[]>((s, done) =>
      s.readdir(path.path, done),
    )
    const value = raw
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => ({ name: entry.filename, type: fileType(entry.attrs.mode) }))
    this.cache.set(key, { expires: Date.now() + 2_000, value })
    return [...value]
  }

  async lstat(path: HostPath): Promise<Stat> {
    this.assertPath(path)
    const attrs = await this.sftp<import('ssh2').Stats>((s, done) =>
      s.lstat(path.path, done),
    )
    return {
      type: fileType(attrs.mode),
      size: attrs.size,
      mtimeMs: attrs.mtime * 1_000,
      mode: attrs.mode,
    }
  }

  readonly stat = (path: HostPath): Promise<Stat> => this.lstat(path)

  async realpath(path: HostPath): Promise<HostPath> {
    this.assertPath(path)
    return hostPath(
      this.owner.hostId,
      await this.sftp<string>((s, done) => s.realpath(path.path, done)),
    )
  }

  assertPath(path: HostPath): void {
    if (path.hostId !== this.owner.hostId) {
      throw new Error(`SshHost expected ${this.owner.hostId}, got ${path.hostId}`)
    }
  }

  pollingInterests(): ReadonlySet<string> {
    return this.pollingFiles
  }

  forgetFingerprint(path: string): void {
    this.fingerprintObservations.delete(path)
  }

  async pollStamp(
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

  async getSftp(): Promise<SFTPWrapper> {
    if (this.sftpSession) return this.sftpSession
    const generation = this.generation
    const pending = this.owner.openSftp().then((session) => {
      if (generation !== this.generation) {
        session.end()
        throw new Error('SSH SFTP session belongs to a stale connection generation')
      }
      return session
    })
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

  invalidate(path: string): void {
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
    let parent = remoteParent(normalized)
    for (;;) {
      this.cache.delete(`d:${parent}`)
      if (parent === '/') break
      parent = remoteParent(parent)
    }
  }

  private sftp<T>(
    op: (s: SFTPWrapper, done: (e: Error | null | undefined, value: T) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return withAbort(this.getSftp(), signal).then(
      (session) =>
        new Promise<T>((resolve, reject) => {
          let settled = false
          const abort = () => finish(abortError())
          const finish = (reason?: Error | null, value?: T): void => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', abort)
            if (reason) reject(reason)
            else resolve(value as T)
          }
          if (signal?.aborted) {
            finish(abortError())
            return
          }
          signal?.addEventListener('abort', abort, { once: true })
          try {
            op(session, finish)
          } catch (reason) {
            finish(reason instanceof Error ? reason : new Error(String(reason)))
          }
        }),
    )
  }

  private cached<T extends Buffer | DirEntry[]>(key: string): T | undefined {
    const value = this.cache.get(key)
    if (!value || value.expires < Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return value.value as T
  }
}

function writeSftpFile(
  session: SFTPWrapper,
  path: string,
  data: Buffer,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  done: (reason: Error | null | undefined, value: void) => void,
): void {
  if (signal?.aborted) {
    done(abortError(), undefined)
    return
  }
  const stream = session.createWriteStream(path, mode === undefined ? {} : { mode })
  let settled = false
  const abort = () => {
    stream.destroy()
    finish(abortError())
  }
  const finish = (reason?: Error): void => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', abort)
    stream.removeListener('error', onError)
    stream.removeListener('finish', onFinish)
    stream.removeListener('close', onClose)
    done(reason, undefined)
  }
  const onError = (reason: Error) => finish(reason)
  const onFinish = () => finish()
  const onClose = () => finish(new Error('SSH file write closed before completion'))
  stream.once('error', onError)
  stream.once('finish', onFinish)
  stream.once('close', onClose)
  signal?.addEventListener('abort', abort, { once: true })
  stream.end(data)
}

function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => finish(abortError())
    const finish = (reason?: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (reason !== undefined) {
        reject(reason instanceof Error ? reason : new Error('SSH file operation failed'))
      } else resolve(value as T)
    }
    signal.addEventListener('abort', abort, { once: true })
    void task.then(
      (value) => finish(undefined, value),
      (reason: unknown) => finish(reason),
    )
  })
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export function remoteParent(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

export function remoteChild(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`
}

export function fileType(mode: number): FileType {
  const type = mode & 0o170000
  return type === 0o100000
    ? 'file'
    : type === 0o040000
      ? 'dir'
      : type === 0o120000
        ? 'symlink'
        : 'other'
}

export function metadataStamp(attrs: import('ssh2').Attributes): string {
  return `${fileType(attrs.mode)}:${attrs.mtime}:${attrs.size}:${attrs.mode}`
}

export function sftpLstat(
  sftp: SFTPWrapper,
  path: string,
): Promise<import('ssh2').Stats> {
  return new Promise((resolve, reject) =>
    sftp.lstat(path, (error, value) => (error ? reject(error) : resolve(value))),
  )
}

export function sftpReaddir(
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

function isNoSuchFile(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}

function contentDigest(value: Buffer): string {
  return createHash('sha256').update(value).digest('base64')
}

function fileChangedError(): Error {
  return new Error(
    'File changed on the remote host since it was opened; reload before saving',
  )
}
