import { createRequire } from 'node:module'
export interface ExtensionStorageBinding {
  metadata(): string
  lockWriter(fd: number): boolean
  openChild(fd: number, name: string, directory: boolean): number
  createChild(fd: number, name: string, directory: boolean): number
  entryNames(fd: number, limit: number): string[]
  unlinkChild(
    fd: number,
    name: string,
    directory: boolean,
    dev: number,
    ino: number,
  ): void
}
const loadNative = createRequire(import.meta.url)

export function extensionStorageBinding(): ExtensionStorageBinding {
  const candidate = loadNative('@hvir/extension-storage') as ExtensionStorageBinding
  if (candidate.metadata() !== 'hvir.extension-storage.v1')
    throw new Error('Extension storage native support is unavailable')
  return candidate
}
