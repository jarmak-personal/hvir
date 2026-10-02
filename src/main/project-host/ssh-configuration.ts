import { join } from 'node:path'

import { localPath, type HostPath } from '../../shared/host-path'
import type { AddSshHostRequest } from '../../shared/ssh-configuration'
import type { LocalHost } from './local-host'
import { parseSshConfig, type SshAliasConfig } from './ssh-config'
import {
  MAX_SSH_CONFIG_BYTES,
  prependSshHost,
  validateSshHostRequest,
} from './ssh-configuration-policy'

/** Fixed-destination, bounded local SSH config access; no connection/authentication authority. */
export class SshConfiguration {
  private readonly file: HostPath
  private readonly directory: HostPath
  private pending: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()

  constructor(
    private readonly local: LocalHost,
    private readonly home: string,
  ) {
    this.directory = localPath(join(home, '.ssh'))
    this.file = localPath(join(home, '.ssh', 'config'))
  }

  refresh(): Promise<readonly SshAliasConfig[]> {
    return this.enqueue(async () => parseSshConfig((await this.read()).text, this.home))
  }

  save(
    request: AddSshHostRequest,
    assertActive: () => void,
  ): Promise<readonly SshAliasConfig[]> {
    const fields = validateSshHostRequest(request)
    return this.enqueue(async () => {
      assertActive()
      const snapshot = await this.read()
      const text = prependSshHost(snapshot.text, fields, this.home)
      if (Buffer.byteLength(text) > MAX_SSH_CONFIG_BYTES)
        throw new Error('SSH config is too large to add a host here')
      try {
        await this.local.createDirectoryExclusive(this.directory, {
          mode: 0o700,
          signal: this.abort.signal,
        })
      } catch (reason) {
        if (
          (reason as NodeJS.ErrnoException).code !== 'EEXIST' &&
          (reason as Error).name !== 'ProjectPathExistsError'
        )
          throw reason
      }
      const current = await this.read()
      if (current.text !== snapshot.text || current.mtimeMs !== snapshot.mtimeMs) {
        throw new Error(
          'SSH config changed while saving. Review your fields and try again',
        )
      }
      assertActive()
      try {
        await this.local.writeFile(this.file, text, {
          signal: this.abort.signal,
          ...(snapshot.mtimeMs === undefined
            ? { createOnly: true, mode: 0o600 }
            : { expectedMtimeMs: snapshot.mtimeMs }),
        })
      } catch (reason) {
        const code = (reason as NodeJS.ErrnoException).code
        if (
          code === 'EEXIST' ||
          code === 'ENOENT' ||
          (reason instanceof Error && reason.message.startsWith('File changed'))
        ) {
          throw new Error(
            'SSH config changed while saving. Review your fields and try again',
            { cause: reason },
          )
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw new Error(
            'Cannot save ~/.ssh/config. Check its permissions and try again',
            { cause: reason },
          )
        }
        throw reason
      }
      return parseSshConfig(text, this.home)
    })
  }

  dispose(): Promise<void> {
    this.abort.abort()
    return this.pending.then(
      () => undefined,
      () => undefined,
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.abort.signal.throwIfAborted()
      const result = await operation()
      this.abort.signal.throwIfAborted()
      return result
    }
    const result = this.pending.then(run, run)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<{ text: string; mtimeMs?: number }> {
    let before
    try {
      before = await this.local.stat(this.file)
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' }
      throw reason
    }
    if (before.type !== 'file')
      throw new Error('SSH config must be a regular file. Check ~/.ssh/config')
    const prefix = await this.local.readTextFilePrefix(this.file, MAX_SSH_CONFIG_BYTES, {
      signal: this.abort.signal,
    })
    if (!prefix.complete || !prefix.validUtf8)
      throw new Error('SSH config must be valid UTF-8 and at most 256 KiB')
    const after = await this.local.stat(this.file)
    if (
      after.type !== 'file' ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new Error('SSH config changed while reading. Try again')
    return { text: prefix.content, mtimeMs: after.mtimeMs }
  }
}
