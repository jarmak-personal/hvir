import {
  containsHostPath,
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  joinHostPath,
  isProjectFileEntryName,
  LOCAL_HOST_ID,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  assertNormalizedAbsoluteProjectPath,
  proveRealProjectDirectory,
} from './project-file-confinement'
import type { VerifiedProjectCopyDestination } from './verified-project-copy'

/** Private authority for one picker-selected destination and its exact staging tree. */
export async function acquireDownloadDestination(options: {
  readonly host: ProjectHost
  readonly selectedPath: string
  readonly name: string
  readonly stagingId: string
  readonly assertOperationCurrent: () => void
}) {
  const { host, assertOperationCurrent } = options
  const transfer = host.fileTransfer
  if (host.hostId !== LOCAL_HOST_ID || !transfer) {
    throw new Error('Local download streaming is unavailable')
  }
  if (
    !isProjectFileEntryName(options.name) ||
    !isProjectFileEntryName(`.hvir-import-${options.stagingId}`)
  ) {
    throw new Error('The download destination name is invalid')
  }
  const selected = hostPath(LOCAL_HOST_ID, options.selectedPath)
  assertNormalizedAbsoluteProjectPath(selected)
  assertOperationCurrent()
  const directory = await host.realpath(selected)
  const publishedPath = joinHostPath(directory, options.name)
  const stagingPath = joinHostPath(directory, `.hvir-import-${options.stagingId}`)
  let revoked = false
  const assertCurrent = (): void => {
    if (revoked) throw new Error('The download destination grant was revoked')
    assertOperationCurrent()
  }
  // Cleanup retains only this parent proof, independently of publication authority.
  const proveCleanupParent = async (): Promise<HostPath> => {
    if (
      !hostPathEquals(directory, await host.realpath(selected)) ||
      !hostPathEquals(directory, await host.realpath(directory)) ||
      (await host.stat(directory)).type !== 'dir'
    )
      throw new Error('The selected download directory changed')
    return directory
  }
  const proveCleanupPath = async (path: HostPath): Promise<void> => {
    assertNormalizedAbsoluteProjectPath(path)
    if (!containsHostPath(stagingPath, path))
      throw new Error('Download cleanup escaped its staging tree')
    await proveCleanupParent()
    await proveRealProjectDirectory(host, directory, directory, dirnameHostPath(path))
  }
  const revalidate = async (): Promise<HostPath> => {
    assertCurrent()
    const result = await proveCleanupParent()
    assertCurrent()
    return result
  }
  const prove = async (path: HostPath): Promise<void> => {
    assertCurrent()
    assertNormalizedAbsoluteProjectPath(path)
    if (!hostPathEquals(path, publishedPath) && !containsHostPath(stagingPath, path)) {
      throw new Error('The download destination escaped its grant')
    }
    await revalidate()
    await proveRealProjectDirectory(host, directory, directory, dirnameHostPath(path))
    assertCurrent()
  }
  const proveRegular = async (path: HostPath): Promise<void> => {
    await prove(path)
    if ((await host.stat(path)).type !== 'file') {
      throw new Error('Download verification requires a regular file')
    }
    assertCurrent()
  }
  const destination: VerifiedProjectCopyDestination = {
    async stat(path) {
      await prove(path)
      return host.stat(path)
    },
    async readdir(path) {
      await prove(path)
      if ((await host.stat(path)).type !== 'dir')
        throw new Error('Download traversal requires a real directory')
      return host.readdir(path)
    },
    async createDirectoryExclusive(path, opts) {
      await prove(path)
      return host.createDirectoryExclusive(path, opts)
    },
    fileTransfer: {
      async *readFileChunks(path, opts) {
        await proveRegular(path)
        for await (const chunk of transfer.readFileChunks(path, opts)) {
          assertCurrent()
          yield chunk
        }
      },
      async writeFileChunksExclusive(path, chunks, opts) {
        await prove(path)
        return transfer.writeFileChunksExclusive(path, chunks, opts)
      },
      async setMetadata(path, opts) {
        await prove(path)
        if (!['file', 'dir'].includes((await host.stat(path)).type))
          throw new Error('Download metadata requires a real entry')
        assertCurrent()
        return transfer.setMetadata(path, opts)
      },
      async renameNoReplace(source, target, opts) {
        if (
          !hostPathEquals(source, stagingPath) ||
          !hostPathEquals(target, publishedPath)
        ) {
          throw new Error('Download publication escaped its grant')
        }
        await prove(source)
        await prove(target)
        return transfer.renameNoReplace(source, target, opts)
      },
      removeDirectory() {
        return Promise.reject(
          new Error('Download publication grants cannot remove entries'),
        )
      },
    },
  }
  await revalidate()
  return {
    destination,
    directory,
    stagingPath,
    assertCurrent,
    revalidate,
    proveCleanupParent,
    proveCleanupPath,
    revoke() {
      revoked = true
    },
  }
}
