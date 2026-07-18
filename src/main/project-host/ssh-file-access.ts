import { createHash, randomUUID } from 'node:crypto'

import type { SFTPWrapper } from 'ssh2'

import {
  hostPath,
  type DirEntry,
  type FileType,
  type HostId,
  type HostPath,
  type Stat,
} from '../../shared'
import type { ReadFileOptions, WriteFileOptions } from './project-host'

export interface SshFileAccessOptions {
  readonly fingerprintObservationWindowMs?: number
}

export interface SshFileAccessOwner {
  readonly hostId: HostId
  openSftp(): Promise<SFTPWrapper>
}

/** Generation-scoped SFTP session, remote file cache, and save authority. */
export class SshFileAccess {
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
  ) {}

  advanceGeneration(): void {
    this.generation++
    const session = this.sftpSession
    this.sftpSession = undefined
    this.cache.clear()
    this.readDigests.clear()
    this.fingerprintObservations.clear()
    void session?.then(
      (value) => value.end(),
      () => undefined,
    )
  }

  dispose(): void {
    this.advanceGeneration()
    this.pollingFiles.clear()
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

  async writeFile(
    path: HostPath,
    value: Uint8Array | string,
    opts: WriteFileOptions = {},
  ): Promise<void> {
    this.assertPath(path)
    const data = Buffer.from(value)
    const parent = remoteParent(path.path)
    const basename = path.path.slice(parent === '/' ? 1 : parent.length + 1)
    const temporary = `${parent === '/' ? '' : parent}/.${basename}.hvir-${randomUUID()}.tmp`
    let mode: number | undefined
    try {
      const attrs = await this.sftp<import('ssh2').Stats>((s, done) =>
        s.lstat(path.path, done),
      )
      mode = attrs.mode & 0o777
    } catch (reason) {
      if (!isNoSuchFile(reason)) throw reason
    }
    const expectedDigest = this.readDigests.get(path.path)
    try {
      await this.sftp<void>((s, done) =>
        s.writeFile(temporary, data, mode === undefined ? {} : { mode }, done),
      )
      if (opts.expectedMtimeMs !== undefined) {
        const currentAttrs = await this.sftp<import('ssh2').Stats>((s, done) =>
          s.lstat(path.path, done),
        )
        if (currentAttrs.mtime * 1_000 !== opts.expectedMtimeMs) {
          throw fileChangedError()
        }
      }
      if (expectedDigest !== undefined) {
        const current = await this.sftp<Buffer>((s, done) => s.readFile(path.path, done))
        if (contentDigest(current) !== expectedDigest) throw fileChangedError()
      }
      try {
        await this.sftp<void>((s, done) =>
          s.ext_openssh_rename(temporary, path.path, done),
        )
      } catch {
        await this.sftp<void>((s, done) => s.rename(temporary, path.path, done))
      }
    } catch (reason) {
      await this.sftp<void>((s, done) => s.unlink(temporary, done)).catch(() => undefined)
      throw reason
    }
    this.readDigests.set(path.path, contentDigest(data))
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

  async stat(path: HostPath): Promise<Stat> {
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
  ): Promise<T> {
    return this.getSftp().then(
      (session) =>
        new Promise<T>((resolve, reject) =>
          op(session, (reason, value) => {
            if (reason) reject(reason)
            else resolve(value)
          }),
        ),
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
