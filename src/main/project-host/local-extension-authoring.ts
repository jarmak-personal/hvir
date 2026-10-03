/** Descriptor-relative mechanics for explicit offline extension authoring. */
import { constants, close, fstat, fstatSync, closeSync, write, fchmod } from 'node:fs'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { dirname, basename, normalize } from 'node:path'
import { LOCAL_HOST_ID, type HostPath } from '../../shared/host-path'
import { loadAtomicRenameBinding } from './local-atomic-rename-binding'
import { extensionStorageBinding } from './local-extension-storage-binding'

const closeFd = promisify(close),
  statFd = promisify(fstat),
  writeFd = promisify(write),
  chmodFd = promisify(fchmod)

export async function materializeLocalExtensionAssets(
  path: HostPath,
  files: ReadonlyMap<string, Uint8Array>,
  kind: 'directory' | 'file',
): Promise<void> {
  if (
    path.hostId !== LOCAL_HOST_ID ||
    !path.path.startsWith('/') ||
    path.path.includes('\0') ||
    normalize(path.path) !== path.path ||
    path.path.endsWith('/')
  )
    throw new Error('Select an absolute local destination without dot segments')
  if (
    !files.size ||
    files.size > 16 ||
    (kind === 'file' && files.size !== 1) ||
    [...files].some(
      ([name, bytes]) =>
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) ||
        name === '.' ||
        name === '..' ||
        bytes.byteLength > 2 * 1024 * 1024,
    )
  )
    throw new Error('Invalid fixed authoring assets')
  // These root-owned macOS aliases are ordinary system paths, not author-selected links.
  const physical =
    process.platform === 'darwin'
      ? path.path.replace(/^\/(tmp|var|etc)(?=\/)/, '/private/$1')
      : path.path
  const binding = extensionStorageBinding()
  const root = await fs.open(
    '/',
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  const descriptors: number[] = []
  const stage = `.hvir-authoring-${randomUUID()}`
  let parent = root.fd,
    stageFd: number | undefined,
    published = false
  const components = dirname(physical).split('/').filter(Boolean)
  const assertParent = (): void => {
    let fd = root.fd
    const opened: number[] = []
    try {
      for (const [index, name] of components.entries()) {
        fd = binding.openChild(fd, name, true)
        opened.push(fd)
        const selected = fstatSync(fd),
          pinned = fstatSync(descriptors[index]!)
        if (selected.dev !== pinned.dev || selected.ino !== pinned.ino)
          throw new Error(
            'Selected parent changed; output was preserved without following the replacement',
          )
      }
    } finally {
      for (const fd of opened.reverse()) closeSync(fd)
    }
  }
  try {
    for (const name of components) {
      parent = binding.openChild(parent, name, true)
      descriptors.push(parent)
    }
    try {
      await fs.lstat(physical)
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
      assertParent()
      stageFd = binding.createChild(parent, stage, kind === 'directory')
    }
    if (stageFd === undefined)
      throw new Error('Destination is occupied; select a new destination')
    // Exclusive staging and leaf creation never follow a replacement link or overwrite content.
    const identity = await statFd(stageFd)
    for (const [name, bytes] of files) {
      const target = kind === 'file' ? stageFd : binding.createChild(stageFd, name, false)
      try {
        let offset = 0
        while (offset < bytes.byteLength) {
          const part = await writeFd(
            target,
            bytes,
            offset,
            bytes.byteLength - offset,
            null,
          )
          if (!part.bytesWritten) throw new Error('Authoring write made no progress')
          offset += part.bytesWritten
        }
        await chmodFd(target, 0o644)
      } finally {
        if (kind === 'directory') await closeFd(target)
      }
    }
    if (kind === 'directory') await chmodFd(stageFd, 0o755)
    assertParent()
    const named = binding.openChild(parent, stage, kind === 'directory')
    try {
      const current = fstatSync(named)
      if (identity.dev !== current.dev || identity.ino !== current.ino)
        throw new Error('Authoring staging entry changed; content was preserved')
    } finally {
      closeSync(named)
    }
    const rename = loadAtomicRenameBinding()
    const result = rename.renameNoReplace(parent, stage, parent, basename(physical))
    if (result !== 0)
      throw new Error(
        'Destination is occupied or publication was refused; select a new destination',
      )
    published = true
    assertParent()
    const output = binding.openChild(parent, basename(physical), kind === 'directory')
    try {
      const current = fstatSync(output)
      if (identity.dev !== current.dev || identity.ino !== current.ino)
        throw new Error(
          'Published output changed before completion; inspect the selected destination',
        )
    } finally {
      closeSync(output)
    }
  } catch (reason) {
    // No path-based cleanup: a swapped entry or uncertain partial belongs to the user to inspect.
    throw new Error(
      `${reason instanceof Error ? reason.message : 'Authoring failed'}. ${stageFd === undefined ? 'No output was created' : published ? 'Publication may have completed in the original parent; inspect it before retrying' : `Any partial output remains in the original parent as ${stage}`}; no existing destination was replaced.`,
      { cause: reason },
    )
  } finally {
    if (stageFd !== undefined) await closeFd(stageFd).catch(() => undefined)
    for (const fd of descriptors.reverse()) await closeFd(fd).catch(() => undefined)
    await root.close()
  }
  if (!published) throw new Error('Authoring publication did not finish')
}
