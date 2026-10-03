import { createHash, randomUUID } from 'node:crypto'
import {
  EXTENSION_LIMITS,
  type ExtensionManifest,
} from '../../shared/extensions/contract'
import {
  extensionAssetPath,
  validateExtensionManifest,
  validateExtensionAssetTopology,
} from '../../shared/extensions/manifest'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionArchive } from './package-archive'
import type { CapturedExtensionBytes } from '../project-host/extension-storage-port'

export interface ExtensionRevision {
  readonly hash: string
  readonly manifest: ExtensionManifest
  readonly warnings: readonly string[]
  readonly sourceIdentity: string
  readonly files: ReadonlyMap<string, Uint8Array>
}

export function validateCapturedExtension(
  capture: CapturedExtensionBytes,
): ExtensionRevision {
  const manifestBytes = capture.files.get('hvir-extension.json')
  if (!manifestBytes || manifestBytes.byteLength > EXTENSION_LIMITS.manifestBytes)
    throw new Error('Provide a bounded hvir-extension.json manifest')
  const { manifest, warnings } = validateExtensionManifest(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
  )
  const hash = createHash('sha256')
  validateExtensionAssetTopology(
    [...capture.files.keys()].map((name) => [name, false] as const),
  )
  for (const [name, bytes] of [...capture.files].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    extensionAssetPath(name)
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  for (const view of [
    ...manifest.views,
    ...(manifest.updater ? [{ entry: manifest.updater }] : []),
  ]) {
    if (!capture.files.has(view.entry) || !view.entry.endsWith('.html'))
      throw new Error(`Viewer entry ${view.entry} must be an existing HTML asset`)
  }
  return {
    hash: hash.digest('hex'),
    manifest,
    warnings,
    sourceIdentity: capture.sourceIdentity,
    files: capture.files,
  }
}

/** Capture and validate an ordinary source without allocating revision-storage authority. */
export async function captureExtensionSource(
  host: ProjectHost,
  source: HostPath,
  signal?: AbortSignal,
): Promise<ExtensionRevision & { readonly kind: 'directory' | 'zip' | 'development' }> {
  const storage = host.extensionStorage
  if (!storage) throw new Error('Local extension storage is unavailable')
  const inspected = await storage.inspectSource(source)
  const archive =
    inspected.kind === 'zip'
      ? await storage.readArchive(inspected.resolved, EXTENSION_LIMITS.archiveBytes)
      : undefined
  if (archive && archive.identity !== inspected.identity)
    throw new Error('ZIP source changed before capture')
  const capture = archive
    ? {
        sourceIdentity: archive.identity,
        files: await captureExtensionArchive(archive.bytes, signal),
      }
    : await storage.captureDirectory(inspected.resolved, EXTENSION_LIMITS, signal)
  const after = await storage.inspectSource(source)
  if (
    inspected.identity !== after.identity ||
    inspected.resolved.path !== after.resolved.path ||
    (inspected.kind !== 'zip' &&
      capture.sourceIdentity !== inspected.identity.split(':').slice(-2).join(':'))
  )
    throw new Error('Package source changed during capture; discover it again')
  return {
    ...validateCapturedExtension({ ...capture, sourceIdentity: inspected.identity }),
    kind: inspected.kind,
  }
}

/** One package capture/validation/store path for directory, ZIP and development sources. */
export class ExtensionPackageStore {
  constructor(
    private readonly host: ProjectHost,
    readonly root: HostPath,
  ) {}

  async capture(source: HostPath): Promise<ExtensionRevision> {
    if (!this.host.extensionStorage)
      throw new Error('Local extension storage is unavailable')
    return validateCapturedExtension(
      await this.host.extensionStorage.captureDirectory(source, EXTENSION_LIMITS),
    )
  }

  captureSource(
    source: HostPath,
    signal?: AbortSignal,
  ): Promise<ExtensionRevision & { readonly kind: 'directory' | 'zip' | 'development' }> {
    return captureExtensionSource(this.host, source, signal)
  }

  async retain(revision: ExtensionRevision, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.host.fileTransfer)
      throw new Error('Atomic extension storage is unavailable')
    const destination = joinHostPath(this.root, revision.hash)
    const staging = joinHostPath(this.root, `.capture-${randomUUID()}`)
    const directories: string[] = []
    const files: string[] = []
    await this.host.createDirectoryExclusive(staging, { mode: 0o755, signal })
    try {
      for (const [name, bytes] of revision.files) {
        const parts = name.split('/')
        for (let index = 1; index < parts.length; index++) {
          const directory = parts.slice(0, index).join('/')
          if (directories.includes(directory)) continue
          await this.host.createDirectoryExclusive(joinHostPath(staging, directory), {
            mode: 0o755,
            signal,
          })
          directories.push(directory)
        }
        await this.host.writeFile(joinHostPath(staging, name), bytes, { signal })
        files.push(name)
      }
      try {
        await this.host.fileTransfer.renameNoReplace(staging, destination, { signal })
        return
      } catch (reason) {
        if ((reason as { code?: unknown }).code !== 'EEXIST') throw reason
        const existing = await this.capture(destination)
        if (existing.hash !== revision.hash)
          throw new Error(
            'Captured package storage changed; disable this extension and repair its stored revision',
            { cause: reason },
          )
      }
    } finally {
      // Only paths exclusively created by this capture may be cleaned up.
      for (const name of files.reverse())
        await this.host.removeFile(joinHostPath(staging, name), { ignoreMissing: true })
      for (const name of directories.reverse())
        await this.host.fileTransfer.removeDirectory(joinHostPath(staging, name), {
          ignoreMissing: true,
        })
      await this.host.fileTransfer.removeDirectory(staging, { ignoreMissing: true })
    }
  }

  async load(hash: string): Promise<ExtensionRevision> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid captured revision')
    const revision = await this.capture(joinHostPath(this.root, hash))
    if (revision.hash !== hash) throw new Error('Captured extension revision changed')
    return revision
  }
}
