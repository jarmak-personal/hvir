import { createRequire } from 'node:module'
const ATOMIC_RENAME_HELPER_VERSION = '0.1.0'
const ATOMIC_RENAME_HELPER_PACKAGE = '@hvir/rename-noreplace'
const atomicRenameRequire = createRequire(import.meta.url)

interface AtomicRenameBinding {
  metadata(): unknown
  renameNoReplace(
    sourceParentFd: number,
    source: string,
    destinationParentFd: number,
    destination: string,
  ): unknown
}

export function loadAtomicRenameBinding(): AtomicRenameBinding {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Atomic no-replace publication is unavailable on this platform')
  }
  const manifest = atomicRenameRequire(
    `${ATOMIC_RENAME_HELPER_PACKAGE}/package.json`,
  ) as {
    name?: unknown
    version?: unknown
  }
  if (
    manifest.name !== ATOMIC_RENAME_HELPER_PACKAGE ||
    manifest.version !== ATOMIC_RENAME_HELPER_VERSION
  ) {
    throw new Error('Atomic no-replace helper metadata does not match hvir')
  }
  const candidate = atomicRenameRequire(
    ATOMIC_RENAME_HELPER_PACKAGE,
  ) as Partial<AtomicRenameBinding>
  if (
    typeof candidate.metadata !== 'function' ||
    typeof candidate.renameNoReplace !== 'function' ||
    candidate.metadata() !== 'hvir.rename-noreplace.v1'
  ) {
    throw new Error('Atomic no-replace helper exports do not match hvir')
  }
  return candidate as AtomicRenameBinding
}
