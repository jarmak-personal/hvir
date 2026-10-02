import { fromBuffer, type ZipFile } from 'yauzl'
import { crc32 } from 'node:zlib'
import type { Readable } from 'node:stream'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import {
  extensionAssetPath,
  validateExtensionAssetTopology,
} from '../../shared/extensions/manifest'

/** Bounded data adapter. Extracts into memory, never into a caller-selected filesystem path. */
export async function captureExtensionArchive(
  bytes: Uint8Array,
  authority?: AbortSignal,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (bytes.byteLength > EXTENSION_LIMITS.archiveBytes)
    throw new Error('ZIP compressed input exceeds its size limit')
  const timeout = new AbortController()
  const signal = authority ? AbortSignal.any([authority, timeout.signal]) : timeout.signal
  const timer = setTimeout(
    () => timeout.abort(new Error('ZIP preparation exceeded its time limit')),
    EXTENSION_LIMITS.archiveTimeoutMs,
  )
  let rejectPending!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectPending = reject
  })
  void aborted.catch(() => undefined)
  let stream: Readable | undefined
  let zip: ZipFile | undefined
  const fail = (): void => {
    rejectPending(signal.reason)
    stream?.destroy()
    zip?.close()
  }
  signal.addEventListener('abort', fail, { once: true })
  if (signal.aborted) fail()
  try {
    zip = await Promise.race([
      new Promise<ZipFile>((resolve, reject) =>
        fromBuffer(
          Buffer.from(bytes),
          {
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
          },
          (error, value) => {
            if (error) reject(error)
            else if (signal.aborted) {
              value.close()
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('ZIP preparation revoked'),
              )
            } else resolve(value)
          },
        ),
      ),
      aborted,
    ])
    const files = new Map<string, Uint8Array>()
    const destinations = new Map<string, boolean>()
    const topology = new Map<string, boolean>()

    let total = 0
    let count = 0
    zip.on('error', (reason: Error) => rejectPending(reason))
    const iterator = zip.eachEntry()
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      const entry = next.value
      signal.throwIfAborted()
      if (++count > EXTENSION_LIMITS.files) throw new Error('ZIP has too many entries')
      const directory = entry.fileName.endsWith('/')
      const name = extensionAssetPath(
        directory ? entry.fileName.slice(0, -1) : entry.fileName,
      )
      const parts = name.split('/')
      if (parts.length - (directory ? 0 : 1) > EXTENSION_LIMITS.depth)
        throw new Error('ZIP directories are too deep')
      const portable = name.normalize('NFC').toLowerCase()
      if (destinations.has(portable)) throw new Error('ZIP destinations conflict')
      for (let index = 1; index < parts.length; index++) {
        if (
          destinations.get(
            parts.slice(0, index).join('/').normalize('NFC').toLowerCase(),
          ) === false
        )
          throw new Error('ZIP file and directory destinations conflict')
      }
      if (
        !directory &&
        [...destinations.keys()].some((prior) => prior.startsWith(`${portable}/`))
      )
        throw new Error('ZIP file and directory destinations conflict')
      destinations.set(portable, directory)
      topology.set(name, directory)
      validateExtensionAssetTopology(topology)
      const type = (entry.externalFileAttributes >>> 16) & 0o170000
      if (
        (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
        entry.isEncrypted()
      )
        throw new Error(
          'ZIP may contain only unencrypted ordinary files and directories, without links',
        )
      if (directory) {
        if (entry.uncompressedSize !== 0) throw new Error('ZIP directory contains data')
        continue
      }
      if (
        entry.uncompressedSize > EXTENSION_LIMITS.fileBytes ||
        total + entry.uncompressedSize > EXTENSION_LIMITS.packageBytes
      )
        throw new Error('ZIP expanded assets exceed their size limit')
      const opening = zip.openReadStreamPromise(entry).then((value) => {
        if (signal.aborted) {
          value.destroy()
          throw signal.reason
        }
        return value
      })
      stream = await Promise.race([opening, aborted])
      const chunks: Buffer[] = []
      let size = 0
      let checksum = 0
      for await (const chunk of stream) {
        if (!(chunk instanceof Buffer)) throw new Error('Invalid ZIP asset bytes')
        size += chunk.byteLength
        if (
          size > entry.uncompressedSize ||
          size > EXTENSION_LIMITS.fileBytes ||
          total + size > EXTENSION_LIMITS.packageBytes
        )
          throw new Error('ZIP expanded assets exceed their size limit')
        checksum = crc32(chunk, checksum)
        chunks.push(chunk)
      }
      if (checksum !== entry.crc32)
        throw new Error('ZIP asset checksum failed; copy a complete uncorrupted package')
      if (size !== entry.uncompressedSize) throw new Error('ZIP asset size changed')
      total += size
      files.set(name, Buffer.concat(chunks, size))
      stream = undefined
    }
    signal.throwIfAborted()
    return files
  } finally {
    clearTimeout(timer)
    stream?.destroy()
    signal.removeEventListener('abort', fail)
    zip?.close()
  }
}
