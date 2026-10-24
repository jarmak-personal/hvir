import { containsHostPath, dirnameHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { proveRealProjectDirectory } from './project-file-confinement'
import type { VerifiedProjectCopySource } from './verified-project-copy'

/** Reprove real parents on every traversal/read, including verification passes. */
export function confinedProjectCopySource(options: {
  readonly host: ProjectHost
  readonly workspaceRoot: HostPath
  readonly root: HostPath
  readonly assertCurrent: () => void
}): VerifiedProjectCopySource {
  const { host, workspaceRoot, root, assertCurrent } = options
  const prove = async (path: HostPath): Promise<void> => {
    assertCurrent()
    if (!containsHostPath(root, path)) throw new Error('The download source escaped')
    await proveRealProjectDirectory(
      host,
      workspaceRoot,
      workspaceRoot,
      dirnameHostPath(path),
    )
    assertCurrent()
  }
  return {
    root,
    async stat(path) {
      await prove(path)
      return host.stat(path)
    },
    async readdir(path) {
      await prove(path)
      if ((await host.stat(path)).type !== 'dir') {
        throw new Error('Download traversal requires a real directory')
      }
      return host.readdir(path)
    },
    async *readFileChunks(path, signal) {
      await prove(path)
      if ((await host.stat(path)).type !== 'file' || !host.fileTransfer) {
        throw new Error('Download streaming requires a regular file')
      }
      for await (const chunk of host.fileTransfer.readFileChunks(path, { signal })) {
        assertCurrent()
        yield chunk
      }
      await prove(path)
    },
  }
}
