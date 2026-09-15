import type { ProjectFileStreamOptions } from './project-host'
import { PROJECT_FILE_STREAM_CHUNK_BYTES } from './project-host'

interface ReadHandle {
  readonly fd: number
  close(): Promise<void>
  stat(): Promise<{ isFile(): boolean }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>
}
export interface LocalConfinedReadPort {
  open(path: string, flags: number): Promise<ReadHandle>
  readonly flags: {
    readonly O_RDONLY: number
    readonly O_DIRECTORY: number
    readonly O_NOFOLLOW: number
    readonly O_NONBLOCK: number
  }
}

/** OS mechanics only. LocalHost supplies primitives; callers retain content authority. */
export async function* readLocalFileChunksNoFollow(
  path: string,
  port: LocalConfinedReadPort,
  options: ProjectFileStreamOptions = {},
): AsyncIterable<Uint8Array> {
  const parts = path.split('/').slice(1)
  if (
    !path.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('A confined read requires a canonical absolute path')
  options.signal?.throwIfAborted()
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = port.flags
  let file: ReadHandle | undefined
  try {
    if (process.platform === 'darwin') {
      // Darwin sys/fcntl.h: O_NOFOLLOW_ANY forbids symlinks in every path component.
      // Never fall back to a plain open when this kernel capability is unavailable.
      file = await port.open(path, O_RDONLY | O_NONBLOCK | 0x20000000)
    } else if (process.platform === 'linux') {
      let directory = await port.open('/', O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      try {
        for (const part of parts.slice(0, -1)) {
          options.signal?.throwIfAborted()
          const next = await port.open(
            `/proc/self/fd/${directory.fd}/${part}`,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
          )
          const previous = directory
          directory = next
          await previous.close()
        }
        options.signal?.throwIfAborted()
        file = await port.open(
          `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
          O_RDONLY | O_NONBLOCK | O_NOFOLLOW,
        )
      } finally {
        await directory.close()
      }
    } else {
      throw new Error('Confined local file reads are unavailable on this platform')
    }
    options.signal?.throwIfAborted()
    if (!(await file.stat()).isFile())
      throw new Error('The reviewed entry is not a regular file')
    const buffer = Buffer.allocUnsafe(PROJECT_FILE_STREAM_CHUNK_BYTES)
    for (;;) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null)
      if (!bytesRead) return
      yield Buffer.from(buffer.subarray(0, bytesRead))
    }
  } finally {
    await file?.close()
  }
}
