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
  if (!(await identity(staging)) && (await identity(path))) {
    if (!host.fileTransfer) throw new Error('Atomic package removal is unavailable')
    await assertWritable()
    await host.fileTransfer.renameNoReplace(path, staging, { signal })
  }
  const claimed = await identity(staging)
  if (claimed && claimed !== removal.identity) {
    try {
      await assertWritable()
      await host.fileTransfer!.renameNoReplace(staging, path, { signal })
      await restored()
    } catch {
      /* Keep exact intent when restoration cannot finish. */
    }
    throw new Error(
      'Package entry changed during removal. Nothing was deleted; inspect the selected package and unfinished removal',
    )
  }
  if (!claimed) return
  await assertWritable()
  if ((await storage.entryIdentity(staging)) !== removal.identity)
    throw new Error('Package cleanup entry was replaced')
  if (removal.kind === 'development')
    await storage.removeDevelopmentLink(staging, removal.identity, signal)
  else if (host.fileDeletion?.capability === 'recoverable')
    await host.fileDeletion.trashEntry(staging, { signal })
  else throw new Error('Recoverable trash is unavailable; package removal is unfinished')
}
