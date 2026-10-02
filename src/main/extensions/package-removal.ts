import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PackageRemoval } from './installation-state'

/** Exact package-file cleanup. Activation owns persisted intent, identity and revocation. */
export async function finishPackageRemoval(
  host: ProjectHost,
  directory: HostPath,
  removal: PackageRemoval,
  signal: AbortSignal,
  assertWritable: () => Promise<void>,
  restored: () => Promise<void>,
): Promise<void> {
  const storage = host.extensionStorage!
  const identity = async (path: HostPath): Promise<string | undefined> =>
    storage.entryIdentity(path).catch((reason: unknown) => {
      if ((reason as { code?: unknown }).code === 'ENOENT') return undefined
      throw reason
    })
  const path = joinHostPath(directory, removal.source)
  const staging = joinHostPath(directory, removal.staging)
  if (removal.kind !== 'development' && host.fileDeletion?.capability !== 'recoverable')
    throw new Error(
      'Recoverable trash is unavailable. The package remains in the extensions folder; restore trash support, then retry Remove.',
    )
  if (!(await identity(staging)) && (await identity(path))) {
    if (!host.fileTransfer) throw new Error('Atomic package removal is unavailable')
    await assertWritable()
    await host.fileTransfer.renameNoReplace(path, staging, { signal })
  }
  const claimed = await identity(staging)
  const restore = async (expected: string): Promise<void> => {
    await assertWritable()
    if ((await identity(staging)) !== expected)
      throw new Error('Package cleanup entry was replaced')
    await host.fileTransfer!.renameNoReplace(staging, path, { signal })
  }
  if (claimed && claimed !== removal.identity) {
    try {
      await restore(claimed)
      await restored()
    } catch {
      /* Keep exact intent when restoration cannot finish. */
    }
    throw new Error(
      `Package entry changed during removal. Nothing was deleted; inspect ${path.path} and ${staging.path}`,
    )
  }
  if (!claimed) return
  await assertWritable()
  if ((await storage.entryIdentity(staging)) !== removal.identity)
    throw new Error('Package cleanup entry was replaced')
  if (removal.kind === 'development') {
    await storage.removeDevelopmentLink(staging, removal.identity, signal)
    return
  }
  try {
    if (host.fileDeletion?.capability !== 'recoverable')
      throw new Error('Recoverable trash is unavailable')
    await host.fileDeletion.trashEntry(staging, { signal })
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : 'Trash failed'
    try {
      await restore(removal.identity)
    } catch {
      throw new Error(
        `${detail}. Removal is unfinished. Close hvir and inspect ${staging.path} and ${path.path}; preserve any different package at the original path. Restore trash support and retry Remove.`,
        { cause: reason },
      )
    }
    throw new Error(
      `${detail}. The package was restored to ${path.path}; restore trash support and retry Remove.`,
      { cause: reason },
    )
  }
}
