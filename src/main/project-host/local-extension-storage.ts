/** Immediate local extension-storage effects, private to the LocalHost facade. */
import { constants, close, fstat, read, type Stats } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { basename, dirname } from 'node:path'
import { LOCAL_HOST_ID, type HostPath } from '../../shared/host-path'
import type {
  CapturedExtensionBytes,
  ExtensionStoragePort,
  ExtensionWriterLease,
  ExtensionSource,
} from './extension-storage-port'

interface ExtensionStorageBinding {
  metadata(): string
  lockWriter(fd: number): boolean
  openChild(fd: number, name: string, directory: boolean): number
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
  async removeDevelopmentLink(
    path: HostPath,
    identity: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = await fs.open(
      dirname(local(path)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const current = await fs.lstat(local(path))
      if (!current.isSymbolicLink() || `${current.dev}:${current.ino}` !== identity)
        throw new Error('Development link changed before removal')
      signal?.throwIfAborted()
      binding().unlinkChild(
        parent.fd,
        basename(path.path),
        false,
        current.dev,
        current.ino,
      )
    } finally {
      await parent.close()
    }
  }
  async entryIdentity(path: HostPath): Promise<string> {
    const entry = await fs.lstat(local(path))
    return `${entry.dev}:${entry.ino}`
  }
  async inspectSource(path: HostPath): Promise<ExtensionSource> {
    const name = local(path)
    const entry = await fs.lstat(name)
    const identity = `${entry.dev}:${entry.ino}`
    if (entry.isSymbolicLink()) {
      const resolved = { ...path, path: await fs.realpath(name) }
      const target = await fs.lstat(resolved.path)
      if (!target.isDirectory())
        throw new Error('A development link must point to a package directory')
      return {
        kind: 'development',
        identity: `${identity}:${target.dev}:${target.ino}`,
        resolved,
      }
    }
    if (entry.isDirectory()) return { kind: 'directory', identity, resolved: path }
    if (entry.isFile() && entry.nlink === 1 && name.toLowerCase().endsWith('.zip'))
      return { kind: 'zip', identity, resolved: path }
    throw new Error('Use a package directory, ZIP, or a development link to a directory')
  }

  async readArchive(
    path: HostPath,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly identity: string }> {
    const file = await fs.open(
      local(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
        throw new Error(
          'ZIP compressed input exceeds its size limit or is not an ordinary file',
        )
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await file.stat()
      if (
        offset !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error(
          'ZIP changed during capture; finish copying it and discover again',
        )
      if (!sameEntry(before, await fs.lstat(local(path))))
        throw new Error('ZIP source was replaced during capture')
      return { bytes: bytes.subarray(0, offset), identity: `${before.dev}:${before.ino}` }
    } finally {
      await file.close()
    }
  }

  async collectDirectory(
    path: HostPath,
    expected: CapturedExtensionBytes,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.captureDirectory(
      path,
      {
        files: maxEntries,
        depth: 12,
        fileBytes: 2 * 1024 * 1024,
        packageBytes: 16 * 1024 * 1024,
      },
      signal,
    )
    if (
      current.sourceIdentity !== expected.sourceIdentity ||
      current.files.size !== expected.files.size ||
      [...current.files].some(
        ([name, bytes]) =>
          !Buffer.from(bytes).equals(Buffer.from(expected.files.get(name) ?? [])),
      )
    )
      throw new Error('Stored package changed before cleanup')
    const native = binding()
    const parent = await fs.open(
      dirname(local(path)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const directories = new Set<string>(expected.directories)
    for (const name of expected.files.keys()) {
      const parts = name.split('/')
      for (let index = 1; index < parts.length; index++)
        directories.add(parts.slice(0, index).join('/'))
    }
    let entries = 0
    const visit = async (fd: number, depth: number, prefix: string): Promise<void> => {
      if (depth > 12) throw new Error('Stored package cleanup is too deep')
      for (const name of native.entryNames(fd, maxEntries + 1)) {
        signal?.throwIfAborted()
        if (++entries > maxEntries)
          throw new Error('Stored package cleanup has too many entries')
        const child = native.openChild(fd, name, false)
        try {
          const stat = await inspectDescriptor(child)
          const relative = prefix ? `${prefix}/${name}` : name
          if (stat.isDirectory()) {
            if (!directories.has(relative))
              throw new Error('Stored package cleanup found an unexpected directory')
            await visit(child, depth + 1, relative)
          } else {
            const approved = expected.files.get(relative)
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              !approved ||
              stat.size !== approved.byteLength
            )
              throw new Error('Stored package cleanup found an unexpected entry')
            const bytes = Buffer.alloc(stat.size + 1)
            let offset = 0
            while (offset < bytes.length) {
              signal?.throwIfAborted()
              const part = await readDescriptor(
                child,
                bytes,
                offset,
                bytes.length - offset,
                offset,
              )
              if (!part.bytesRead) break
              offset += part.bytesRead
            }
            const after = await inspectDescriptor(child)
            if (
              offset !== stat.size ||
              !bytes.subarray(0, offset).equals(Buffer.from(approved)) ||
              stat.mtimeMs !== after.mtimeMs ||
              stat.ctimeMs !== after.ctimeMs
            )
              throw new Error('Stored package asset changed before cleanup')
          }
          signal?.throwIfAborted()
          native.unlinkChild(fd, name, stat.isDirectory(), stat.dev, stat.ino)
        } finally {
          await closeDescriptor(child)
        }
      }
    }
    try {
      const name = basename(path.path)
      const root = native.openChild(parent.fd, name, true)
      try {
        const info = await inspectDescriptor(root)
        if (`${info.dev}:${info.ino}` !== expected.sourceIdentity)
          throw new Error('Stored package directory was replaced before cleanup')
        await visit(root, 0, '')
        signal?.throwIfAborted()
        native.unlinkChild(parent.fd, name, true, info.dev, info.ino)
      } finally {
        await closeDescriptor(root)
      }
    } finally {
      await parent.close()
    }
  }

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
    signal?: AbortSignal,
  ): Promise<CapturedExtensionBytes> {
    const native = binding()
    const root = await fs.open(
      local(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const files = new Map<string, Uint8Array>()
    const directories: string[] = []
    let bytes = 0
    let entries = 0
    const visit = async (fd: number, prefix: string, depth: number): Promise<void> => {
      if (depth > bounds.depth) throw new Error('Package directories are too deep')
      const names = native.entryNames(fd, bounds.files + 1).sort()
      for (const name of names) {
        signal?.throwIfAborted()
        if (++entries > bounds.files) throw new Error('Package has too many entries')
        const child = native.openChild(fd, name, false)
        try {
          const info = await inspectDescriptor(child)
          const relative = prefix ? `${prefix}/${name}` : name
          if (info.isDirectory()) {
            directories.push(relative)
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
            signal?.throwIfAborted()
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
      return { sourceIdentity: `${identity.dev}:${identity.ino}`, files, directories }
    } finally {
      await root.close()
    }
  }
}
