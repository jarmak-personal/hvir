import type { SFTPWrapper } from 'ssh2'

import type { HostId, HostPath, Stat } from '../../shared'
import {
  ProjectPathExistsError,
  isProjectPathExistsError,
  type ExclusiveCreateOptions,
} from './project-host'

interface SshExclusiveCreatePort {
  readonly hostId: HostId
  getSftp(): Promise<SFTPWrapper>
  stat(path: HostPath): Promise<Stat>
  invalidate(path: string): void
}

/** Immediate exclusive SFTP mechanics; recursive workflow policy stays above ProjectHost. */
export class SshExclusiveCreate {
  constructor(private readonly port: SshExclusiveCreatePort) {}

  async file(path: HostPath, opts: ExclusiveCreateOptions): Promise<void> {
    this.assertPath(path)
    opts.signal?.throwIfAborted()
    let handle: Buffer | undefined
    let created = false
    try {
      handle = await this.perform<Buffer>((session, done) =>
        session.open(path.path, 'wx', { mode: opts.mode }, done),
      )
      created = true
      opts.onCreated?.()
      opts.signal?.throwIfAborted()
      await this.perform<void>((session, done) =>
        session.fsetstat(handle!, { mode: opts.mode }, done),
      )
      await this.perform<void>((session, done) => session.close(handle!, done))
      handle = undefined
      opts.signal?.throwIfAborted()
      const stat = await this.port.stat(path)
      opts.signal?.throwIfAborted()
      if (stat.type !== 'file' || stat.size !== 0 || (stat.mode & 0o777) !== opts.mode) {
        throw new Error('SSH host did not create the approved empty regular file')
      }
    } catch (reason) {
      if (!created) await this.rethrowCollision(path, reason)
      if (handle) {
        await this.perform<void>((session, done) => session.close(handle!, done)).catch(
          () => undefined,
        )
      }
      await this.perform<void>((session, done) => session.unlink(path.path, done)).catch(
        () => undefined,
      )
      throw reason
    }
    this.port.invalidate(path.path)
  }

  async directory(path: HostPath, opts: ExclusiveCreateOptions): Promise<void> {
    this.assertPath(path)
    opts.signal?.throwIfAborted()
    let created = false
    try {
      await this.perform<void>((session, done) =>
        session.mkdir(path.path, { mode: opts.mode }, done),
      )
      created = true
      opts.onCreated?.()
      opts.signal?.throwIfAborted()
      await this.perform<void>((session, done) =>
        session.setstat(path.path, { mode: opts.mode }, done),
      )
      opts.signal?.throwIfAborted()
      const stat = await this.port.stat(path)
      opts.signal?.throwIfAborted()
      if (stat.type !== 'dir' || (stat.mode & 0o777) !== opts.mode) {
        throw new Error('SSH host did not create the approved empty directory')
      }
    } catch (reason) {
      if (!created) await this.rethrowCollision(path, reason)
      await this.perform<void>((session, done) => session.rmdir(path.path, done)).catch(
        () => undefined,
      )
      throw reason
    }
    this.port.invalidate(path.path)
  }

  private async rethrowCollision(path: HostPath, reason: unknown): Promise<never> {
    if (isProjectPathExistsError(reason)) throw new ProjectPathExistsError()
    try {
      await this.perform<import('ssh2').Stats>((session, done) =>
        session.lstat(path.path, done),
      )
    } catch {
      throw reason
    }
    throw new ProjectPathExistsError()
  }

  private perform<T>(
    operation: (
      session: SFTPWrapper,
      done: (error: Error | null | undefined, value: T) => void,
    ) => void,
  ): Promise<T> {
    return this.port.getSftp().then(
      (session) =>
        new Promise<T>((resolve, reject) => {
          operation(session, (error, value) => (error ? reject(error) : resolve(value)))
        }),
    )
  }

  private assertPath(path: HostPath): void {
    if (path.hostId !== this.port.hostId) {
      throw new Error(`SshHost expected ${this.port.hostId}, got ${path.hostId}`)
    }
  }
}
