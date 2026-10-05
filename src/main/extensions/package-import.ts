import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionSource } from './package-store'

/** Copies one validated selection; publication never replaces an existing source. */
export async function importExtensionPackage(
  host: ProjectHost,
  directory: HostPath,
  stagingRoot: HostPath,
  source: HostPath,
  available: (name: string, packageId: string) => Promise<void>,
  current: () => Promise<void>,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<void> {
  const storage = host.extensionStorage,
    transfer = host.fileTransfer
  if (!storage || !transfer) throw new Error('Atomic extension storage is unavailable')
  await current()
  const revision = await captureExtensionSource(host, source, signal, 'import')
  const kind = revision.kind
  if (kind === 'development')
    throw new Error(
      'Select an ordinary extension directory or ZIP, without a development link',
    )
  const name = basename(source.path)
  if (!name || name.startsWith('.') || name.length > 128)
    throw new Error('Give the package a visible filename of at most 128 characters')
  await available(name, revision.manifest.id)
  await current()
  const stage = joinHostPath(stagingRoot, `.import-${randomUUID()}`),
    output = kind === 'zip' ? joinHostPath(stage, name) : stage,
    destination = joinHostPath(directory, name)
  await host.createDirectoryExclusive(stage, { mode: 0o755, signal })
  const identity = await storage.entryIdentity(stage).catch((reason: unknown) => {
    throw new Error(
      `Import staging could not be identified safely. Inspect ${stage.path}; existing packages were not replaced`,
      { cause: reason },
    )
  })
  const files =
    kind === 'zip' ? new Map([[name, revision.archiveBytes!]]) : revision.files
  const created = new Map<string, Uint8Array>()
  const directories = new Set<string>()
  let published = false
  let failure: Error | undefined
  try {
    for (const [name, bytes] of files) {
      await current()
      const parts = name.split('/')
      for (let index = 1; index < parts.length; index++) {
        const relative = parts.slice(0, index).join('/')
        if (directories.has(relative)) continue
        await host.createDirectoryExclusive(joinHostPath(stage, relative), {
          mode: 0o755,
          signal,
        })
        directories.add(relative)
      }
      await transfer.writeFileChunksExclusive(
        joinHostPath(stage, name),
        (async function* () {
          yield await Promise.resolve(bytes)
        })(),
        { mode: 0o644, signal },
      )
      created.set(name, bytes)
    }
    const fresh = await captureExtensionSource(host, source, signal, 'import')
    if (
      fresh.hash !== revision.hash ||
      fresh.sourceIdentity !== revision.sourceIdentity ||
      (revision.archiveBytes &&
        (!fresh.archiveBytes ||
          !Buffer.from(revision.archiveBytes).equals(Buffer.from(fresh.archiveBytes))))
    )
      throw new Error(
        'The selected package changed; finish copying it and Add extension again',
      )
    await available(name, revision.manifest.id)
    await current()
    await transfer.renameNoReplace(output, destination, {
      signal,
      onSubmitted: assertCurrent,
    })
    published = true
  } catch (reason) {
    failure = new Error(
      (reason as { code?: unknown }).code === 'EEXIST'
        ? 'A package with this filename already exists. Remove it explicitly or choose a different filename.'
        : reason instanceof Error
          ? reason.message
          : 'Extension import failed',
      { cause: reason },
    )
  } finally {
    // A published directory has transferred out of staging. A ZIP leaves an empty stage.
    if (!published || kind === 'zip') {
      const expected = {
        sourceIdentity: identity,
        files: published ? new Map<string, Uint8Array>() : created,
        directories: [...directories],
      }
      try {
        await storage.collectDirectory(stage, expected, {
          ...EXTENSION_LIMITS,
          fileBytes: Math.max(EXTENSION_LIMITS.fileBytes, EXTENSION_LIMITS.archiveBytes),
          packageBytes: Math.max(
            EXTENSION_LIMITS.packageBytes,
            EXTENSION_LIMITS.archiveBytes,
          ),
        })
      } catch (cleanup) {
        failure = new AggregateError(
          failure === undefined ? [cleanup] : [failure, cleanup],
          `${failure?.message ?? 'Extension import finished'}. Staging cleanup needs attention at ${stage.path}; existing packages were not replaced`,
        )
      }
    }
  }
  if (failure !== undefined) throw failure
}

/** Only the current serialized writer collects its bounded interrupted import staging. */
export async function collectInterruptedExtensionImport(
  host: ProjectHost,
  path: HostPath,
  current: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const bounds = {
    ...EXTENSION_LIMITS,
    fileBytes: EXTENSION_LIMITS.archiveBytes,
    packageBytes: EXTENSION_LIMITS.archiveBytes,
  }
  const storage = host.extensionStorage!
  await current()
  const captured = await storage.captureDirectory(path, bounds, signal)
  await current()
  await storage.collectDirectory(path, captured, bounds, signal)
}
