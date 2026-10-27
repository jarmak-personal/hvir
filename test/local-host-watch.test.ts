import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { afterEach, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type WatchEvent } from '../src/shared'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('preserves atomic saves after native watch capacity forces polling', async () => {
  vi.stubEnv('CHOKIDAR_USEPOLLING', undefined)
  vi.stubEnv('CHOKIDAR_INTERVAL', undefined)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hvir-watch-')))
  const file = localPath(join(directory, 'document.md'))
  const host = new LocalHost()
  const events: WatchEvent[] = []
  const errors: Error[] = []
  const realWatch = chokidar.watch
  const watch = vi.spyOn(chokidar, 'watch')
  try {
    await writeFile(file.path, 'before')
    host.watch(localPath(directory), (event) => events.push(event), {
      recursive: false,
      onError: (error) => errors.push(error),
    })
    const native = watch.mock.results[0]!.value as FSWatcher
    await once(native, 'ready')

    let polling: FSWatcher | undefined
    const pollingReady = new Promise<void>((resolve, reject) => {
      watch.mockImplementationOnce((paths, options) => {
        // Speed up observation without changing the production atomic window.
        polling = realWatch(paths, { ...options, pollingInterval: 10 })
        polling.once('ready', resolve).once('error', reject)
        return polling
      })
    })
    native.emit('error', Object.assign(new Error('Watch capacity'), { code: 'ENOSPC' }))
    await pollingReady
    expect(native.closed).toBe(true)
    expect(polling!.options.atomic).toBe(true)

    // A real atomic save has no scheduling-dependent missing-file interval.
    // Directory reconciliation may retire a file poll before it emits `raw`,
    // so observe the public change instead of waiting for that backend detail.
    const replacement = join(directory, 'replacement.md')
    await writeFile(replacement, 'after')
    await rename(replacement, file.path)
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: 'change', path: file })
    })
    // Both add and change refresh an open document; an unlink would wrongly
    // mark its review deleted. Inode replacement can also produce an add.
    expect(events).not.toContainEqual({ type: 'unlink', path: file })
    expect(await readFile(file.path, 'utf8')).toBe('after')

    // Real deletion must still reach consumers after the coalescing window.
    await rm(file.path)
    await vi.waitFor(() => {
      expect(events.filter((event) => event.path.path === file.path).at(-1)).toEqual({
        type: 'unlink',
        path: file,
      })
    })
    expect(errors).toEqual([])
    await host.dispose()
    expect(polling!.closed).toBe(true)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
