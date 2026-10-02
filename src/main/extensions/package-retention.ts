import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionPackageStore, ExtensionRevision } from './package-store'

/** Package policy lives beneath the activation writer. No autonomous timer or second writer. */
export async function collectExtensionPackages(
  host: ProjectHost,
  packages: ExtensionPackageStore,
  protectedHashes: ReadonlySet<string>,
  assertWritable: () => Promise<void>,
  candidate?: ExtensionRevision,
  signal?: AbortSignal,
): Promise<void> {
  const storage = host.extensionStorage
  if (!storage) throw new Error('Extension storage is unavailable')
  await assertWritable()
  const names = await storage.installationNames(
    packages.root,
    EXTENSION_LIMITS.retainedRevisions + 32,
  )
  const revisions: {
    name: string
    revision: ExtensionRevision
    bytes: number
    modified: number
  }[] = []
  for (const name of names) {
    const path = joinHostPath(packages.root, name)
    if (/^\.capture-[a-f0-9-]{36}$/u.test(name)) {
      const captured = await storage.captureDirectory(path, EXTENSION_LIMITS, signal)
      await assertWritable()
      await storage.collectDirectory(path, captured, EXTENSION_LIMITS, signal)
    } else if (/^[a-f0-9]{64}$/u.test(name)) {
      const revision = await packages.load(name).catch((reason: unknown) => {
        throw new Error(
          protectedHashes.has(name)
            ? `Accepted stored revision ${name} cannot be validated. Disable or remove its saved installation state before repairing this exact revision in extension-state/packages.`
            : `Unused stored revision ${name} cannot be collected safely. Close hvir, move only extension-state/packages/${name} outside that folder, then restart and retry. User libraries and project data are separate.`,
          { cause: reason },
        )
      })
      revisions.push({
        name,
        revision,
        bytes: [...revision.files.values()].reduce(
          (sum, bytes) => sum + bytes.byteLength,
          0,
        ),
        modified: (await host.stat(path)).mtimeMs,
      })
    } else
      throw new Error(
        'Unexpected stored package entry; repair extension-state/packages before collecting revisions',
      )
  }
  const candidateExists =
    !!candidate && revisions.some((entry) => entry.name === candidate.hash)
  let count = revisions.length + (candidate && !candidateExists ? 1 : 0)
  let bytes =
    revisions.reduce((sum, entry) => sum + entry.bytes, 0) +
    (candidate && !candidateExists
      ? [...candidate.files.values()].reduce((sum, value) => sum + value.byteLength, 0)
      : 0)
  const ownedIds = new Set(
    revisions
      .filter((entry) => protectedHashes.has(entry.name))
      .map((entry) => entry.revision.manifest.id),
  )
  if (candidate) ownedIds.add(candidate.manifest.id)
  const retained = new Map<string, number>()
  if (candidate && !candidateExists) retained.set(candidate.manifest.id, 1)
  for (const entry of revisions) {
    if (!protectedHashes.has(entry.name)) continue
    const id = entry.revision.manifest.id
    retained.set(id, (retained.get(id) ?? 0) + 1)
  }
  if (
    [...retained.values()].some(
      (used) => used > EXTENSION_LIMITS.revisionsPerInstallation,
    )
  )
    throw new Error(
      'Protected package revision capacity is full; resolve its pending operation before accepting another revision',
    )
  const victims: typeof revisions = []
  for (const entry of revisions.sort(
    (a, b) => b.modified - a.modified || a.name.localeCompare(b.name),
  )) {
    if (protectedHashes.has(entry.name)) continue
    const id = entry.revision.manifest.id
    const used = retained.get(id) ?? 0
    if (!ownedIds.has(id) || used >= EXTENSION_LIMITS.revisionsPerInstallation)
      victims.push(entry)
    else retained.set(id, used + 1)
  }
  count -= victims.length
  bytes -= victims.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of revisions.toReversed()) {
    if (
      count <= EXTENSION_LIMITS.retainedRevisions &&
      bytes <= EXTENSION_LIMITS.retainedBytes
    )
      break
    if (protectedHashes.has(entry.name) || victims.includes(entry)) continue
    victims.push(entry)
    count--
    bytes -= entry.bytes
  }
  // Count preselected per-installation victims exactly once before capacity admission.
  const remaining = revisions.filter((entry) => !victims.includes(entry))
  const remainingCount = remaining.length + (candidate && !candidateExists ? 1 : 0)
  const remainingBytes =
    remaining.reduce((sum, entry) => sum + entry.bytes, 0) +
    (candidate && !candidateExists
      ? [...candidate.files.values()].reduce((sum, value) => sum + value.byteLength, 0)
      : 0)
  if (
    remainingCount > EXTENSION_LIMITS.retainedRevisions ||
    remainingBytes > EXTENSION_LIMITS.retainedBytes
  )
    throw new Error(
      'Retained package capacity is full. Remove unused installation state before accepting this revision',
    )
  for (const entry of victims) {
    await assertWritable()
    await storage.collectDirectory(
      joinHostPath(packages.root, entry.name),
      entry.revision,
      EXTENSION_LIMITS,
      signal,
    )
  }
}
