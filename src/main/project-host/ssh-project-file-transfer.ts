import type { SFTPWrapper } from 'ssh2'

import type { HostId, HostPath, Stat } from '../../shared'
import {
  PROJECT_FILE_STREAM_CHUNK_BYTES,
  ProjectPathExistsError,
  type ProjectFileMetadataOptions,
  type ProjectFileStreamOptions,
  type ProjectFileWriteStreamOptions,
} from './project-host'

export interface SshProjectFileTransferPort {
  readonly hostId: HostId
  getSftp(): Promise<SFTPWrapper>
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
    const handle = await this.request<Buffer>(
      (session, done) => session.open(path.path, 'r', done),
      opts.signal,
    )
    let position = 0
    try {
      for (;;) {
        const value = await this.request<{ bytesRead: number; data: Buffer }>(
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
          opts.signal,
        )
        opts.signal?.throwIfAborted()
        if (value.bytesRead === 0) return
        position += value.bytesRead
        yield value.data.subarray(0, value.bytesRead)
      }
    } finally {
      await this.perform<void>((session, done) => session.close(handle, done)).catch(
        () => undefined,
      )
    }
  }

  async writeFileChunksExclusive(
    path: HostPath,
    chunks: AsyncIterable<Uint8Array>,
    opts: ProjectFileWriteStreamOptions,
  ): Promise<void> {
    this.assertPath(path)
    let handle: Buffer | undefined
    let position = 0
    try {
      try {
        handle = await this.request<Buffer>(
          (session, done) => session.open(path.path, 'wx', { mode: opts.mode }, done),
          opts.signal,
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
          const length = Math.min(
            PROJECT_FILE_STREAM_CHUNK_BYTES,
            value.byteLength - offset,
          )
          await this.request<void>(
            (session, done) =>
              session.write(handle!, value, offset, length, position, done),
            opts.signal,
          )
          offset += length
          position += length
        }
      }
      opts.signal?.throwIfAborted()
      await this.request<void>(
        (session, done) => session.fsetstat(handle!, { mode: opts.mode }, done),
        opts.signal,
      )
      await this.perform<void>((session, done) => session.close(handle!, done))
      handle = undefined
    } catch (reason) {
      if (handle) {
        await this.perform<void>((session, done) => session.close(handle!, done)).catch(
          () => undefined,
        )
        await this.perform<void>((session, done) =>
          session.unlink(path.path, done),
        ).catch(() => undefined)
      }
      throw reason
    }
    this.port.invalidate(path.path)
  }

  async setMetadata(path: HostPath, opts: ProjectFileMetadataOptions): Promise<void> {
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
    opts: ProjectFileStreamOptions = {},
  ): Promise<void> {
    this.assertPath(source)
    this.assertPath(destination)
    try {
      await this.request<void>(
        (session, done) => session.rename(source.path, destination.path, done),
        opts.signal,
      )
    } catch (reason) {
      try {
        await this.port.stat(destination)
        throw new ProjectPathExistsError()
      } catch (statReason) {
        if (statReason instanceof ProjectPathExistsError) throw statReason
      }
      throw reason
    }
    this.port.invalidate(source.path)
    this.port.invalidate(destination.path)
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
  ): Promise<T> {
    signal?.throwIfAborted()
    const session = await this.port.getSftp()
    signal?.throwIfAborted()
    return callbackRequest(session, operation)
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

function callbackRequest<T>(
  session: SFTPWrapper,
  operation: (
    session: SFTPWrapper,
    done: (error: Error | null | undefined, value: T) => void,
  ) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      operation(session, (reason, value) => {
        if (reason) reject(reason)
        else resolve(value)
      })
    } catch (reason) {
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
  })
}

function isNoSuchFile(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}
