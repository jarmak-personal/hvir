import type { SFTPWrapper } from 'ssh2'

import {
  dirnameHostPath,
  hostPathEquals,
  type HostId,
  type HostPath,
  type Stat,
} from '../../shared'
import {
  PROJECT_FILE_STREAM_CHUNK_BYTES,
  ProjectPathExistsError,
  type ProjectFileMetadataOptions,
  type ProjectFileRenameOptions,
  type ProjectFileStreamOptions,
  type ProjectFileWriteStreamOptions,
} from './project-host'

export interface SshProjectFileTransferPort {
  readonly hostId: HostId
  getSftp(signal?: AbortSignal): Promise<SFTPWrapper>
  stat(path: HostPath): Promise<Stat>
  invalidate(path: string): void
}

/** Immediate SFTP transfer mechanics with truthful post-submission cancellation. */
export class SshProjectFileTransfer {
  constructor(private readonly port: SshProjectFileTransferPort) {}

  async *readFileChunks(
    path: HostPath,
    opts: ProjectFileStreamOptions = {},
  ): AsyncIterable<Uint8Array> {
    this.assertPath(path)
    const session = await this.port.getSftp(opts.signal)
    opts.signal?.throwIfAborted()
    const handle = await callbackRequest<Buffer>(session, (session, done) =>
      session.open(path.path, 'r', done),
    )
    let position = 0
    try {
      for (;;) {
        opts.signal?.throwIfAborted()
        const value = await callbackRequest<{ bytesRead: number; data: Buffer }>(
          session,
          (session, done) => {
            const buffer = Buffer.allocUnsafe(PROJECT_FILE_STREAM_CHUNK_BYTES)
            session.read(
              handle,
              buffer,
              0,
              buffer.byteLength,
              position,
              (error, bytesRead, data) =>
                done(error, { bytesRead, data: Buffer.from(data) }),
            )
          },
        )
        opts.signal?.throwIfAborted()
        if (value.bytesRead === 0) return
        position += value.bytesRead
        yield value.data.subarray(0, value.bytesRead)
      }
    } finally {
      await callbackRequest<void>(session, (session, done) =>
        session.close(handle, done),
      ).catch(() => undefined)
    }
  }

  async writeFileChunksExclusive(
    path: HostPath,
    chunks: AsyncIterable<Uint8Array>,
    opts: Omit<ProjectFileWriteStreamOptions, 'mode'> & { readonly mode: number },
  ): Promise<void> {
    this.assertPath(path)
    const session = await this.port.getSftp(opts.signal)
    opts.signal?.throwIfAborted()
    let handle: Buffer | undefined
    let position = 0
    try {
      try {
        handle = await callbackRequest<Buffer>(session, (session, done) =>
          session.open(path.path, 'wx', { mode: opts.mode }, done),
        )
        opts.onCreated?.()
      } catch (reason) {
        try {
          await this.port.stat(path)
          throw new ProjectPathExistsError()
        } catch (statReason) {
          if (statReason instanceof ProjectPathExistsError) throw statReason
        }
        throw reason
      }
      for await (const chunk of chunks) {
        opts.signal?.throwIfAborted()
        const value = Buffer.from(chunk)
        for (let offset = 0; offset < value.byteLength;) {
          opts.signal?.throwIfAborted()
          const length = Math.min(
            PROJECT_FILE_STREAM_CHUNK_BYTES,
            value.byteLength - offset,
          )
          await callbackRequest<void>(session, (session, done) =>
            session.write(handle!, value, offset, length, position, done),
          )
          offset += length
          position += length
        }
      }
      opts.signal?.throwIfAborted()
      await callbackRequest<void>(session, (session, done) =>
        session.fsetstat(handle!, { mode: opts.mode }, done),
      )
      await callbackRequest<void>(session, (session, done) =>
        session.close(handle!, done),
      )
      handle = undefined
    } catch (reason) {
      if (handle) {
        await callbackRequest<void>(session, (session, done) =>
          session.close(handle!, done),
        ).catch(() => undefined)
        if (!opts.preserveOnFailure)
          await this.perform<void>((session, done) =>
            session.unlink(path.path, done),
          ).catch(() => undefined)
      }
      throw reason
    }
    this.port.invalidate(path.path)
  }

  async setMetadata(
    path: HostPath,
    opts: Omit<ProjectFileMetadataOptions, 'mode'> & { readonly mode: number },
  ): Promise<void> {
    this.assertPath(path)
    await this.request<void>(
      (session, done) =>
        session.setstat(
          path.path,
          { mode: opts.mode, atime: opts.mtimeSeconds, mtime: opts.mtimeSeconds },
          done,
        ),
      opts.signal,
    )
    this.port.invalidate(path.path)
  }

  async renameNoReplace(
    source: HostPath,
    destination: HostPath,
    opts: ProjectFileRenameOptions = {},
  ): Promise<void> {
    this.assertPath(source)
    this.assertPath(destination)
    let submitted = false
    try {
      await this.request<void>(
        (session, done) => session.rename(source.path, destination.path, done),
        opts.signal,
        () => {
          submitted = true
          opts.onSubmitted?.()
        },
      )
    } catch (reason) {
      if (!submitted) throw reason
      this.port.invalidate(source.path)
      this.port.invalidate(destination.path)
      const [sourceState, destinationState] = await Promise.all([
        this.inspectPath(source),
        this.inspectPath(destination),
      ])
      if (sourceState === 'missing' && destinationState === 'present') {
        return
      }
      if (sourceState === 'present' && destinationState === 'present') {
        throw new ProjectPathExistsError()
      }
      if (
        sourceState === 'present' &&
        destinationState === 'missing' &&
        (await this.provesCrossDeviceRename(source, destination))
      ) {
        throw remoteCrossDeviceError(reason)
      }
      throw reason
    }
    this.port.invalidate(source.path)
    this.port.invalidate(destination.path)
  }

  private async inspectPath(path: HostPath): Promise<'present' | 'missing' | 'unknown'> {
    try {
      await this.port.stat(path)
      return 'present'
    } catch (reason) {
      return isNoSuchFile(reason) ? 'missing' : 'unknown'
    }
  }

  private async provesCrossDeviceRename(
    source: HostPath,
    destination: HostPath,
  ): Promise<boolean> {
    const sourceParent = dirnameHostPath(source)
    const destinationParent = dirnameHostPath(destination)
    if (hostPathEquals(sourceParent, destinationParent)) return false
    const [sourceFilesystem, destinationFilesystem] = await Promise.all([
      this.inspectFilesystemId(sourceParent),
      this.inspectFilesystemId(destinationParent),
    ])
    return (
      sourceFilesystem !== undefined &&
      destinationFilesystem !== undefined &&
      sourceFilesystem !== destinationFilesystem
    )
  }

  private async inspectFilesystemId(path: HostPath): Promise<string | undefined> {
    try {
      const info = await this.perform<unknown>((session, done) =>
        session.ext_openssh_statvfs(path.path, (error, value: unknown) =>
          done(error, value),
        ),
      )
      return statvfsFilesystemId(info)
    } catch {
      return undefined
    }
  }

  async removeDirectory(
    path: HostPath,
    opts: { readonly ignoreMissing?: boolean } = {},
  ): Promise<void> {
    this.assertPath(path)
    try {
      await this.perform<void>((session, done) => session.rmdir(path.path, done))
    } catch (reason) {
      if (!opts.ignoreMissing || !isNoSuchFile(reason)) throw reason
    }
    this.port.invalidate(path.path)
  }

  /** Check before submission, then await the remote callback without abort-racing it. */
  private async request<T>(
    operation: (
      session: SFTPWrapper,
      done: (error: Error | null | undefined, value: T) => void,
    ) => void,
    signal?: AbortSignal,
    onSubmitted?: () => void,
  ): Promise<T> {
    signal?.throwIfAborted()
    const session = await this.port.getSftp(signal)
    signal?.throwIfAborted()
    return callbackRequest(session, operation, onSubmitted)
  }

  private async perform<T>(
    operation: (
      session: SFTPWrapper,
      done: (error: Error | null | undefined, value: T) => void,
    ) => void,
  ): Promise<T> {
    return callbackRequest(await this.port.getSftp(), operation)
  }

  private assertPath(path: HostPath): void {
    if (path.hostId !== this.port.hostId) {
      throw new Error(`SshHost expected ${this.port.hostId}, got ${path.hostId}`)
    }
  }
}

const sessions = new WeakMap<
  SFTPWrapper,
  { closed: boolean; pending: Set<(reason: Error) => void> }
>()
function callbackRequest<T>(
  session: SFTPWrapper,
  operation: (
    session: SFTPWrapper,
    done: (error: Error | null | undefined, value: T) => void,
  ) => void,
  onSubmitted?: () => void,
): Promise<T> {
  let lifetime = sessions.get(session)
  if (!lifetime) {
    lifetime = { closed: false, pending: new Set() }
    sessions.set(session, lifetime)
    const owned = lifetime
    session.once('close', () => {
      owned.closed = true
      for (const cancel of owned.pending) cancel(new Error('SSH SFTP session closed'))
    })
  }
  if (lifetime.closed) return Promise.reject(new Error('SSH SFTP session closed'))
  const owned = lifetime
  return new Promise<T>((resolve, reject) => {
    let completed = false
    const cancel = (reason: Error): void => {
      settle(reason, undefined as T)
    }
    let synchronous = true
    let synchronousResult:
      { readonly reason: Error | null | undefined; readonly value: T } | undefined
    const settle = (reason: Error | null | undefined, value: T): void => {
      if (completed) return
      completed = true
      owned.pending.delete(cancel)
      if (reason) reject(reason)
      else resolve(value)
    }
    owned.pending.add(cancel)
    try {
      operation(session, (reason, value) => {
        if (synchronous) synchronousResult = { reason, value }
        else settle(reason, value)
      })
      synchronous = false
      onSubmitted?.()
      if (synchronousResult) {
        settle(synchronousResult.reason, synchronousResult.value)
      }
    } catch (reason) {
      synchronous = false
      settle(reason instanceof Error ? reason : new Error(String(reason)), undefined as T)
    }
  })
}

function isNoSuchFile(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}

function statvfsFilesystemId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { readonly f_sid?: unknown }).f_sid
  if (typeof id === 'bigint' && id >= 0n) return id.toString()
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
    ? id.toString()
    : undefined
}

function remoteCrossDeviceError(cause: unknown): Error & { readonly code: 'EXDEV' } {
  return Object.assign(
    new Error('The remote source and destination are on different filesystems', {
      cause,
    }),
    { code: 'EXDEV' as const },
  )
}
