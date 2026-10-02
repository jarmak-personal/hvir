/** Immediate local extension-storage effects, private to the LocalHost facade. */
import { constants, close, fstat, read, type Stats } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { LOCAL_HOST_ID, type HostPath } from '../../shared/host-path'
import type {
  CapturedExtensionBytes,
  ExtensionStoragePort,
  ExtensionWriterLease,
} from './extension-storage-port'

interface ExtensionStorageBinding {
  metadata(): string
  lockWriter(fd: number): boolean
  openChild(fd: number, name: string, directory: boolean): number
  entryNames(fd: number, limit: number): string[]
}
const loadNative = createRequire(import.meta.url)
const closeDescriptor = promisify(close)
const inspectDescriptor = promisify(fstat)
const readDescriptor = promisify(read)

function binding(): ExtensionStorageBinding {
  const candidate = loadNative('@hvir/extension-storage') as ExtensionStorageBinding
  if (candidate.metadata() !== 'hvir.extension-storage.v1')
    throw new Error('Extension storage native support is unavailable')
  return candidate
}

function local(path: HostPath): string {
  if (path.hostId !== LOCAL_HOST_ID || !path.path.startsWith('/'))
    throw new Error('Extension storage requires an absolute local path')
  return path.path
}

function sameEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export class LocalExtensionStorage implements ExtensionStoragePort {
  async installationNames(path: HostPath, limit: number): Promise<readonly string[]> {
    const native = binding()
    const directory = await fs.open(
      local(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      return native.entryNames(directory.fd, limit + 1)
    } finally {
      await directory.close()
    }
  }

  async acquireWriter(
    path: HostPath,
    onLost: () => void,
  ): Promise<ExtensionWriterLease | undefined> {
    const target = local(path)
    const file = await fs.open(
      target,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    let owned = false
    try {
      const identity = await file.stat()
      if (!identity.isFile() || identity.nlink !== 1)
        throw new Error('Invalid extension writer lock file')
      if (!binding().lockWriter(file.fd)) {
        await file.close()
        return undefined
      }
      owned = true
      let releaseTask: Promise<void> | undefined
      const lose = (): void => {
        if (!owned) return
        owned = false
        onLost()
      }
      const assertCurrent = async (): Promise<void> => {
        if (!owned) throw new Error('Extension state write ownership is unavailable')
        try {
          const current = await fs.lstat(target)
          if (!current.isFile() || current.nlink !== 1 || !sameEntry(identity, current))
            throw new Error('Extension writer lock was replaced')
        } catch (reason) {
          lose()
          throw reason
        }
        if (!owned) throw new Error('Extension state write ownership was revoked')
      }
      // Detection revokes idle guests too. The lock is never expired or unlinked.
      const timer = setInterval(() => {
        void assertCurrent().catch(() => undefined)
      }, 500)
      timer.unref()
      try {
        await assertCurrent()
      } catch (reason) {
        clearInterval(timer)
        throw reason
      }
      return {
        assertCurrent,
        release: async () => {
          owned = false
          clearInterval(timer)
          await (releaseTask ??= file.close())
        },
      }
    } catch (reason) {
      owned = false
      await file.close().catch(() => undefined)
      throw reason
    }
  }

  async captureDirectory(
    path: HostPath,
    bounds: Parameters<ExtensionStoragePort['captureDirectory']>[1],
  ): Promise<CapturedExtensionBytes> {
    const native = binding()
    const root = await fs.open(
      local(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const files = new Map<string, Uint8Array>()
    let bytes = 0
    let entries = 0
    const visit = async (fd: number, prefix: string, depth: number): Promise<void> => {
      if (depth > bounds.depth) throw new Error('Package directories are too deep')
      const names = native.entryNames(fd, bounds.files + 1).sort()
      for (const name of names) {
        if (++entries > bounds.files) throw new Error('Package has too many entries')
        const child = native.openChild(fd, name, false)
        try {
          const info = await inspectDescriptor(child)
          const relative = prefix ? `${prefix}/${name}` : name
          if (info.isDirectory()) {
            await visit(child, relative, depth + 1)
            continue
          }
          if (!info.isFile() || info.nlink !== 1)
            throw new Error(
              'Packages may contain only directories and ordinary files, without links',
            )
          if (info.size > bounds.fileBytes || bytes + info.size > bounds.packageBytes)
            throw new Error('Package assets exceed the size limit')
          const buffer = Buffer.alloc(info.size + 1)
          let offset = 0
          while (offset < buffer.length) {
            const { bytesRead } = await readDescriptor(
              child,
              buffer,
              offset,
              buffer.length - offset,
              offset,
            )
            if (bytesRead === 0) break
            offset += bytesRead
          }
          const after = await inspectDescriptor(child)
          if (
            offset !== info.size ||
            after.size !== info.size ||
            after.mtimeMs !== info.mtimeMs ||
            after.ctimeMs !== info.ctimeMs
          )
            throw new Error('Package changed during capture; discover it again')
          bytes += offset
          files.set(relative, buffer.subarray(0, offset))
        } finally {
          await closeDescriptor(child)
        }
      }
    }
    try {
      const identity = await root.stat()
      await visit(root.fd, '', 0)
      return { sourceIdentity: `${identity.dev}:${identity.ino}`, files }
    } finally {
      await root.close()
    }
  }
}
