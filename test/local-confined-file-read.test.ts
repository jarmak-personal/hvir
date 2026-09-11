import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { LocalHost } from '../src/main/project-host/local-host'

it.runIf(['darwin', 'linux'].includes(process.platform)).each(['leaf', 'ancestor'])(
  'refuses a %s replaced by an escaping symlink after the caller checks it',
  async (replacement) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-confined-read-')))
    const host = new LocalHost()
    try {
      const source = join(root, 'source'),
        outside = join(root, 'outside')
      await Promise.all([mkdir(source), mkdir(outside)])
      await writeFile(join(source, 'file'), 'reviewed bytes')
      await writeFile(join(outside, 'file'), 'outside content must never be read')
      const file = localPath(join(source, 'file'))
      expect(await host.realpath(file)).toEqual(file)
      expect((await host.stat(file)).type).toBe('file')
      const stream =
        host.fileTransfer.readFileChunksNoFollow!(file)[Symbol.asyncIterator]()
      const changed = replacement === 'leaf' ? file.path : source
      await rename(changed, `${changed}-original`)
      await symlink(replacement === 'leaf' ? join(outside, 'file') : outside, changed)
      // The original checked path is now a symlink exactly when LocalHost opens it.
      await expect(stream.next()).rejects.toBeDefined()
      // The ordinary reader retains its existing semantics independently of this port.
      const ordinary = host.fileTransfer.readFileChunks(file)[Symbol.asyncIterator]()
      const followed = await ordinary.next()
      if (followed.done)
        throw new Error('Expected the ordinary reader to follow its existing path')
      expect(Buffer.from(followed.value).toString()).toContain('outside content')
      await ordinary.return?.()
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.runIf(['darwin', 'linux'].includes(process.platform))(
  'pins the opened regular file and closes its stream when cancelled',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-confined-read-')))
    const host = new LocalHost()
    try {
      const file = localPath(join(root, 'file'))
      await writeFile(file.path, Buffer.alloc(512 * 1024, 'a'))
      await writeFile(join(root, 'outside'), 'outside content')
      const controller = new AbortController()
      const stream = host.fileTransfer.readFileChunksNoFollow!(file, {
        signal: controller.signal,
      })[Symbol.asyncIterator]()
      expect((await stream.next()).done).toBe(false)
      await rename(file.path, `${file.path}-original`)
      await symlink(join(root, 'outside'), file.path)
      const next = await stream.next()
      if (next.done) throw new Error('Expected retained file bytes')
      expect([...next.value].every((byte) => byte === 97)).toBe(true)
      controller.abort()
      await expect(stream.next()).rejects.toThrow()
      expect((await stream.next()).done).toBe(true)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
