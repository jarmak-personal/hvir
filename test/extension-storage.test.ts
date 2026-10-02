import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { LocalHost } from '../src/main/project-host/local-host'
import { ExtensionPackageStore } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'hvir-extension-storage-'))
  const source = join(root, 'source')
  const store = join(root, 'store')
  await fs.mkdir(source)
  await fs.mkdir(store)
  await fs.writeFile(
    join(source, 'hvir-extension.json'),
    JSON.stringify(exampleManifest()),
  )
  await fs.writeFile(join(source, 'index.html'), '<h1>Original</h1>')
  await fs.writeFile(join(source, 'detail.html'), '<h1>Detail</h1>')
  return {
    root,
    source,
    store,
    host: new LocalHost(),
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  }
}

describe('LocalHost extension storage mechanics', () => {
  it('keeps capture pinned when the source ancestor is replaced after opening, and rejects its replacement link', async () => {
    const data = await fixture()
    const open = fs.open.bind(fs)
    let swapped = false
    const intercepted = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        if (path === data.source && !swapped) {
          swapped = true
          await fs.rename(data.source, `${data.source}.accepted`)
          await fs.symlink(data.root, data.source)
        }
        return handle
      })
    try {
      await fs.writeFile(join(data.root, 'private'), 'ungranted outside')
      const capture = await data.host.extensionStorage.captureDirectory(
        localPath(data.source),
        EXTENSION_LIMITS,
      )
      expect(new TextDecoder().decode(capture.files.get('index.html'))).toBe(
        '<h1>Original</h1>',
      )
      expect(capture.files.has('private')).toBe(false)
      await expect(
        data.host.extensionStorage.captureDirectory(
          localPath(data.source),
          EXTENSION_LIMITS,
        ),
      ).rejects.toThrow()
    } finally {
      intercepted.mockRestore()
      await data.dispose()
    }
  })
  it('publishes a complete retained revision atomically and cleans only its staging after an interrupted write', async () => {
    const data = await fixture()
    const packages = new ExtensionPackageStore(data.host, localPath(data.store))
    const write = data.host.writeFile.bind(data.host)
    let writes = 0
    const interrupted = vi
      .spyOn(data.host, 'writeFile')
      .mockImplementation((...args) =>
        ++writes === 2
          ? Promise.reject(new Error('interrupted capture'))
          : write(...args),
      )
    try {
      const revision = await packages.capture(localPath(data.source))
      await expect(packages.retain(revision)).rejects.toThrow('interrupted capture')
      expect(await fs.readdir(data.store)).toEqual([])
      interrupted.mockRestore()
      await packages.retain(revision)
      await packages.retain(revision)
      expect((await packages.load(revision.hash)).hash).toBe(revision.hash)
      expect(await fs.readdir(data.store)).toEqual([revision.hash])
    } finally {
      interrupted.mockRestore()
      await data.dispose()
    }
  })
  it('shares kernel ownership across data-directory aliases and bounds discovery at enumeration', async () => {
    const data = await fixture()
    const lease = await data.host.extensionStorage.acquireWriter(
      localPath(join(data.root, 'writer.lock')),
      vi.fn(),
    )
    try {
      await fs.symlink(data.root, join(data.root, 'alias'))
      expect(
        await data.host.extensionStorage.acquireWriter(
          localPath(join(data.root, 'alias/writer.lock')),
          vi.fn(),
        ),
      ).toBeUndefined()
      await expect(
        data.host.extensionStorage.installationNames(localPath(data.source), 1),
      ).rejects.toThrow('entries')
    } finally {
      await lease!.release()
      await data.dispose()
    }
  })
  it('captures and retains exact immutable bytes independently of external source edits', async () => {
    const data = await fixture()
    try {
      const packages = new ExtensionPackageStore(data.host, localPath(data.store))
      const original = await packages.capture(localPath(data.source))
      await packages.retain(original)
      await fs.writeFile(join(data.source, 'index.html'), '<script>changed()</script>')
      const changed = await packages.capture(localPath(data.source))
      expect(changed.hash).not.toBe(original.hash)
      expect(new TextDecoder().decode(original.files.get('index.html'))).toBe(
        '<h1>Original</h1>',
      )
      expect((await packages.load(original.hash)).hash).toBe(original.hash)
      await fs.writeFile(join(data.store, original.hash, 'index.html'), 'tampered')
      await expect(packages.load(original.hash)).rejects.toThrow('changed')
    } finally {
      await data.dispose()
    }
  })
  it.each(['symlink', 'directory-link', 'hardlink'] as const)(
    'refuses %s package entries instead of copying outside bytes',
    async (kind) => {
      const data = await fixture()
      try {
        await fs.writeFile(join(data.root, 'outside'), 'private-outside')
        const target = join(data.source, 'escape')
        if (kind === 'hardlink') await fs.link(join(data.root, 'outside'), target)
        else
          await fs.symlink(
            kind === 'directory-link' ? data.root : join(data.root, 'outside'),
            target,
          )
        await expect(
          data.host.extensionStorage.captureDirectory(
            localPath(data.source),
            EXTENSION_LIMITS,
          ),
        ).rejects.toThrow()
      } finally {
        await data.dispose()
      }
    },
  )
  it('enforces file, entry and nesting limits at the read boundary', async () => {
    const data = await fixture()
    try {
      await expect(
        data.host.extensionStorage.captureDirectory(localPath(data.source), {
          ...EXTENSION_LIMITS,
          fileBytes: 2,
        }),
      ).rejects.toThrow('size')
      await expect(
        data.host.extensionStorage.captureDirectory(localPath(data.source), {
          ...EXTENSION_LIMITS,
          files: 1,
        }),
      ).rejects.toThrow('entries')
      await fs.mkdir(join(data.source, 'nested'))
      await fs.writeFile(join(data.source, 'nested', 'asset'), 'asset')
      await expect(
        data.host.extensionStorage.captureDirectory(localPath(data.source), {
          ...EXTENSION_LIMITS,
          depth: 0,
        }),
      ).rejects.toThrow('deep')
    } finally {
      await data.dispose()
    }
  })
  it('keeps a paused live owner exclusive, recovers after process death, and retains the lock inode', async () => {
    const data = await fixture()
    const target = join(data.root, 'writer.lock')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const b=require('@hvir/extension-storage');const fd=fs.openSync(process.argv[1],'a+');if(!b.lockWriter(fd))process.exit(2);process.stdout.write('owned\\n');setInterval(()=>{},1000)`,
        target,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      await once(child.stdout, 'data')
      const initial = await fs.stat(target)
      child.kill('SIGSTOP')
      expect(
        await data.host.extensionStorage.acquireWriter(localPath(target), vi.fn()),
      ).toBeUndefined()
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const lease = await data.host.extensionStorage.acquireWriter(
        localPath(target),
        vi.fn(),
      )
      expect(lease).toBeDefined()
      await lease!.assertCurrent()
      await lease!.release()
      await lease!.release()
      expect((await fs.stat(target)).ino).toBe(initial.ino)
    } finally {
      child.kill('SIGKILL')
      await data.dispose()
    }
  })
  it('revokes when its lock path is replaced and refuses symlink lock aliases', async () => {
    const data = await fixture()
    const target = join(data.root, 'writer.lock')
    const lost = vi.fn()
    try {
      const lease = await data.host.extensionStorage.acquireWriter(
        localPath(target),
        lost,
      )
      await fs.rename(target, `${target}.old`)
      await fs.writeFile(target, '')
      await expect(lease!.assertCurrent()).rejects.toThrow('replaced')
      expect(lost).toHaveBeenCalledOnce()
      await expect(lease!.assertCurrent()).rejects.toThrow('unavailable')
      await lease!.release()
      await fs.symlink(target, `${target}.link`)
      await expect(
        data.host.extensionStorage.acquireWriter(localPath(`${target}.link`), vi.fn()),
      ).rejects.toThrow()
    } finally {
      await data.dispose()
    }
  })
})
