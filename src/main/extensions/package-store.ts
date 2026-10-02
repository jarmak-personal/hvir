import { createHash, randomUUID } from 'node:crypto'
import {
  EXTENSION_LIMITS,
  type ExtensionManifest,
} from '../../shared/extensions/contract'
import {
  extensionAssetPath,
  validateExtensionManifest,
} from '../../shared/extensions/manifest'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
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
  const portableNames = new Set<string>()
  for (const [name, bytes] of [...capture.files].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    extensionAssetPath(name)
    const portable = name.normalize('NFC').toLowerCase()
    if (portableNames.has(portable))
      throw new Error('Package asset paths collide across supported platforms')
    portableNames.add(portable)
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  for (const view of manifest.views) {
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

/** One directory capture/validation/store path, extended by later package lifecycle work. */
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
