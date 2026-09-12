import {
  ManagedDirectoryError,
  parseManagedReceipt,
  parseManagedLocation,
  validateManagedTree,
  refused,
  uncertain,
} from './managed-directory-contract'
import { createHash } from 'node:crypto'
import { type HostPath } from '../../shared/host-path'
import type { ProjectHost } from './project-host'
import type { Disposer } from '../../shared'
import type {
  ManagedDirectoryPort,
  ManagedDirectoryReceipt,
  ManagedDirectoryTree,
  ManagedDirectoryInspection,
  ManagedDirectoryLocation,
} from './managed-directory'
import { MANAGED_DIRECTORY_PROGRAM } from './ssh-managed-directory-operations'

/** Existing SSH exec transport, one fixed program, bounded data and backpressure. */
export class SshManagedDirectory implements ManagedDirectoryPort {
  constructor(
    private readonly host: Pick<ProjectHost, 'hostId' | 'execStream'>,
    private readonly invalidate: (root: HostPath) => void,
  ) {}

  async inspectMany(
    root: HostPath,
    entries: readonly { readonly entry: string; readonly tree: ManagedDirectoryTree }[],
    signal: AbortSignal,
  ): Promise<readonly ManagedDirectoryInspection[]> {
    if (entries.length > 128) throw refused()
    if (!entries.length) {
      signal.throwIfAborted()
      return []
    }
    entries.forEach(({ tree }) => validateManagedTree(tree))
    const result = await this.run({ operation: 'inspect-many', root, entries }, signal)
    if (!Array.isArray(result.results) || result.results.length !== entries.length)
      throw refused()
    return result.results.map((value: unknown, index) => {
      const row = value as Record<string, unknown>
      if (row.status === 'absent')
        return {
          status: 'absent',
          location: parseManagedLocation(row.location, root, entries[index]!.entry),
        }
      if (row.status === 'different') return { status: 'different' }
      if (row.status !== 'exact') throw refused()
      return {
        status: 'exact',
        receipt: parseManagedReceipt(
          row.receipt,
          root,
          entries[index]!.entry,
          entries[index]!.tree,
        ),
      }
    })
  }

  async inspect(
    root: HostPath,
    entry: string,
    tree: ManagedDirectoryTree,
    signal: AbortSignal,
  ): Promise<ManagedDirectoryInspection> {
    const result = await this.run({ operation: 'inspect', root, entry, tree }, signal)
    if (result.status === 'absent')
      return {
        status: 'absent',
        location: parseManagedLocation(result.location, root, entry),
      }
    if (result.status === 'different') return { status: 'different' }
    if (result.status !== 'exact') throw refused()
    return {
      status: 'exact' as const,
      receipt: parseManagedReceipt(result.receipt, root, entry, tree),
    }
  }

  async stage(
    root: HostPath,
    entry: string,
    tree: ManagedDirectoryTree,
    bytes: ReadonlyMap<string, Uint8Array>,
    location: ManagedDirectoryLocation,
    signal: AbortSignal,
  ) {
    validateManagedTree(tree)
    parseManagedLocation(location, root, entry)
    if (
      bytes.size !== tree.files.length ||
      tree.files.some(
        (file) =>
          bytes.get(file.entry)?.byteLength !== file.size ||
          createHash('sha256').update(bytes.get(file.entry)!).digest('hex') !==
            file.sha256,
      )
    )
      throw refused()
    const result = await this.run(
      { operation: 'stage', root, entry, tree, location },
      signal,
      bytes,
    )
    if (result.status === 'not-applied') throw refused()
    if (result.status !== 'staged')
      throw new ManagedDirectoryError(
        'uncertain',
        'Remote staging could not be verified. Any unverified staging entries are retained.',
      )
    return parseManagedReceipt(result.receipt, root, entry, tree)
  }

  async commit(
    operation: Parameters<ManagedDirectoryPort['commit']>[0],
    options: Parameters<ManagedDirectoryPort['commit']>[1],
  ): ReturnType<ManagedDirectoryPort['commit']> {
    const root =
      operation.action === 'add' ? operation.candidate.root : operation.before.root
    const result = await this.run(
      { operation: 'commit', root, ...operation },
      options.signal,
      undefined,
      options.onSubmitted,
    )
    if (result.status === 'not-applied' || result.status === 'uncertain')
      return { status: result.status }
    if (result.status === 'refused') return { status: 'not-applied' as const }
    if (result.status !== 'completed') throw uncertain()
    const published =
      operation.action === 'remove'
        ? undefined
        : parseManagedReceipt(
            result.published,
            root,
            operation.action === 'add' ? operation.target : operation.before.entry,
            operation.candidate.tree,
            operation.candidate,
          )
    const displaced =
      operation.action === 'add'
        ? undefined
        : parseManagedReceipt(
            result.displaced,
            root,
            operation.action === 'remove'
              ? operation.quarantine
              : operation.candidate.entry,
            operation.before.tree,
            operation.before,
          )
    return { status: 'completed' as const, published, displaced }
  }

  async cleanup(receipt: ManagedDirectoryReceipt, signal: AbortSignal): Promise<boolean> {
    const result = await this.run(
      { operation: 'cleanup', root: receipt.root, receipt },
      signal,
    )
    return result.status === 'cleaned'
  }

  private async run(
    request: Record<string, unknown> & { root: HostPath },
    signal: AbortSignal,
    bytes?: ReadonlyMap<string, Uint8Array>,
    onSubmitted?: () => void,
  ): Promise<Record<string, unknown>> {
    if (
      request.root.hostId !== this.host.hostId ||
      !request.root.path.startsWith('/') ||
      request.root.path.includes('\0')
    )
      throw refused()
    const header = JSON.stringify(request) + '\n'
    if (Buffer.byteLength(header) > 1024 * 1024 - 1) throw refused()
    signal.throwIfAborted()
    const abort = new AbortController()
    const stream = this.host.execStream('python3', ['-c', MANAGED_DIRECTORY_PROGRAM], {
      keepStdinOpen: true,
      signal: abort.signal,
    })
    const timer = setTimeout(() => abort.abort(), 30_000)
    const cancel = (): void => abort.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    let output = '',
      stderrBytes = 0,
      outputBytes = 0,
      submitted = false,
      closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      try {
        stream.dispose()
      } catch {
        // Closing a failed transport must not replace its observed outcome.
      }
    }
    const subscriptions: Disposer[] = []
    let rejectExit: (error: unknown) => void = () => {}
    const exited = new Promise<void>((resolve, reject) => {
      rejectExit = reject
      subscriptions.push(
        stream.onStdout((chunk) => {
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes > 2 * 1024 * 1024) {
            abort.abort(uncertain())
            reject(uncertain())
            return
          }
          output += chunk
          if (!submitted && output.includes('{"status":"submitting"}\n')) {
            submitted = true
            onSubmitted?.()
          }
        }),
        stream.onStderr((chunk) => {
          stderrBytes += Buffer.byteLength(chunk)
          if (stderrBytes > 64 * 1024) {
            abort.abort(uncertain())
            reject(uncertain())
          }
        }),
        stream.onError(reject),
        stream.onExit(({ code }) =>
          code === 0
            ? resolve()
            : reject(
                new ManagedDirectoryError(
                  'unavailable',
                  'This action requires Python 3 and secure directory operations on the connected host.',
                ),
              ),
        ),
      )
    })
    // An opened SSH channel does not subscribe to ExecOptions.signal. Own its
    // cancellation here, including writes/end that may never resolve on their own.
    let rejectStopped: (error: unknown) => void = () => {}
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject
    })
    void exited.catch(rejectStopped)
    void stopped.catch(() => {})
    const stop = (): void => {
      if (closed) return
      rejectExit(abort.signal.reason)
      rejectStopped(abort.signal.reason)
      try {
        stream.kill()
      } catch {
        // Disposal remains necessary even if channel termination itself failed.
      } finally {
        close()
      }
    }
    abort.signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) cancel()
    if (abort.signal.aborted) stop()
    const write = async (content: string): Promise<void> => {
      abort.signal.throwIfAborted()
      await Promise.race([stream.write(content), stopped])
      abort.signal.throwIfAborted()
    }
    try {
      // Do not split a surrogate pair at a UTF-8 transport boundary.
      for (let offset = 0; offset < header.length;) {
        let end = Math.min(offset + 16_384, header.length)
        if (end < header.length && /[\uD800-\uDBFF]/.test(header[end - 1]!)) end--
        await write(header.slice(offset, end))
        offset = end
      }
      if (bytes) {
        for (const file of (request.tree as ManagedDirectoryTree).files) {
          const content = bytes.get(file.entry)!
          for (let offset = 0; offset < content.byteLength; offset += 65_536)
            await write(
              Buffer.from(content.subarray(offset, offset + 65_536)).toString('base64') +
                '\n',
            )
          await write('\n')
        }
      }
      abort.signal.throwIfAborted()
      // Once every write was accepted, successful process exit is authoritative
      // even if the transport's stdin-close callback is still settling.
      await Promise.race([stream.end(), exited, stopped])
      await Promise.race([exited, stopped])
      const rows = output.trim().split('\n')
      if (rows.length > 2 || (rows.length === 2 && rows[0] !== '{"status":"submitting"}'))
        throw uncertain()
      const result = JSON.parse(rows.at(-1)!) as Record<string, unknown>
      if (!result || typeof result !== 'object') throw uncertain()
      if (result.status === 'unavailable')
        throw new ManagedDirectoryError(
          'unavailable',
          'This host does not provide the secure directory operation required for this action.',
        )
      // Any failure after the immediate primitive was submitted is indeterminate.
      if (submitted && result.status === 'refused') throw uncertain()
      return result
    } catch (error) {
      if (error instanceof ManagedDirectoryError && !submitted) throw error
      if (
        !submitted &&
        String(request.operation).startsWith('inspect') &&
        abort.signal.aborted
      ) {
        if (signal.aborted) throw signal.reason
        throw new ManagedDirectoryError(
          'unavailable',
          'The remote directory observation timed out.',
        )
      }
      throw uncertain()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      abort.signal.removeEventListener('abort', stop)
      close()
      await Promise.allSettled(
        subscriptions.map(async (dispose) => {
          await dispose()
        }),
      )
      rejectExit(uncertain())
      if (!String(request.operation).startsWith('inspect')) this.invalidate(request.root)
    }
  }
}
