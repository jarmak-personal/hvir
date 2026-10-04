import type { HostPath } from '../../shared/host-path'
import type { ProjectHost, ProjectManagedTransferPort } from './project-host'

/** Immediate host mechanics only: no recursion, grants, journal or tool-domain policy. */
export function managedTransfer(
  host: Pick<ProjectHost, 'hostId' | 'stat' | 'finiteExec'>,
  write: ProjectManagedTransferPort['writeFileChunksExclusive'],
  set: ProjectManagedTransferPort['setMetadata'],
  localIdentity?: (path: HostPath) => Promise<string>,
): ProjectManagedTransferPort {
  return {
    async setMetadata(path, options) {
      if (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o777)
        throw new Error('Managed transfer requires ordinary POSIX permission bits')
      if (path.hostId !== host.hostId) throw new Error('Managed transfer host mismatch')
      await set(path, options)
    },
    async writeFileChunksExclusive(path, chunks, options) {
      if (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o777)
        throw new Error('Managed transfer requires ordinary POSIX permission bits')
      if (path.hostId !== host.hostId) throw new Error('Managed transfer host mismatch')
      await write(path, chunks, options)
    },
    async entryIdentity(path, signal) {
      signal?.throwIfAborted()
      if (path.hostId !== host.hostId || (await host.stat(path)).type !== 'dir')
        throw new Error('Managed identity requires an ordinary directory on its host')
      if (localIdentity) {
        const identity = await localIdentity(path)
        signal?.throwIfAborted()
        return identity
      }
      // Both native commands lstat the exact argv operand. No interpolated path or helper.
      const task = host.finiteExec?.tryExec(
        '/bin/sh',
        [
          '-c',
          'case "$(/usr/bin/uname -s)" in Linux) exec /usr/bin/stat -c "%d:%i:%w" -- "$1";; Darwin) exec /usr/bin/stat -f "%d:%i:%.9FB" -- "$1";; *) exit 78;; esac',
          'hvir-managed-identity',
          path.path,
        ],
        { signal, maxBuffer: 128 },
      )
      if (!task) throw new Error('Managed directory identity is unavailable or busy')
      const result = await task
      signal?.throwIfAborted()
      const identity = result.stdout.trim()
      if (
        result.code !== 0 ||
        result.signal ||
        result.outputTruncated ||
        !/^\d+:\d+:(?:[1-9]\d*\.\d{9}|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} [+-]\d{4})$/u.test(
          identity,
        )
      )
        throw new Error('The SSH host cannot supply native directory identity')
      if ((await host.stat(path)).type !== 'dir')
        throw new Error('Managed directory changed')
      return identity
    },
  }
}
