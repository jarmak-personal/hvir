import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalHost } from '../src/main/project-host/local-host'
import { asHostId, hostPath, localPath, type WatchEvent } from '../src/shared'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await delay(50)
  }
}

describe('LocalHost', () => {
  let dir: string
  let host: LocalHost

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hvir-test-'))
    host = new LocalHost()
    await host.connect()
  })

  afterEach(async () => {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes then reads a file, host-qualified', async () => {
    const p = localPath(join(dir, 'hello.txt'))
    await host.writeFile(p, 'hi there')
    expect(await host.readTextFile(p)).toBe('hi there')
    expect((await host.readFile(p)).toString('utf8')).toBe('hi there')
  })

  it('lists directory entries with types', async () => {
    await writeFile(join(dir, 'a.txt'), 'a')
    await mkdir(join(dir, 'sub'))
    const entries = await host.readdir(localPath(dir))
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.type]))
    expect(byName['a.txt']).toBe('file')
    expect(byName['sub']).toBe('dir')
  })

  it('stats a file', async () => {
    const p = localPath(join(dir, 's.txt'))
    await host.writeFile(p, 'abc')
    const s = await host.stat(p)
    expect(s.type).toBe('file')
    expect(s.size).toBe(3)
    expect(typeof s.mtimeMs).toBe('number')
  })

  it('execs a command and captures stdout', async () => {
    const r = await host.exec('/bin/echo', ['hello'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.stderr).toBe('')
  })

  it('feeds stdin to an exec', async () => {
    const r = await host.exec('cat', [], { input: 'piped-input' })
    expect(r.stdout).toBe('piped-input')
  })

  it('closes stdin when buffered exec has no input', async () => {
    const r = await host.exec('cat', [])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('streams output and closes stdin when no input is supplied', async () => {
    const stream = host.execStream('cat', [])
    let stdout = ''
    stream.onStdout((chunk) => {
      stdout += chunk
    })

    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        stream.onError(reject)
        stream.onExit(resolve)
      },
    )

    expect(result).toEqual({ code: 0, signal: null })
    expect(stdout).toBe('')
    stream.dispose()
  })

  it('reports streaming spawn errors instead of emitting an unhandled error', async () => {
    const stream = host.execStream('/definitely/not/a/real/hvir-command', [])
    const error = await new Promise<Error>((resolve) => stream.onError(resolve))
    expect(error.message).toMatch(/ENOENT/)
    stream.dispose()
  })

  it('rejects a path belonging to a foreign host', async () => {
    const foreign = hostPath(asHostId('remote'), '/x')
    await expect(host.stat(foreign)).rejects.toThrow(/host 'remote'/)
  })

  it('stats a symlink without following it', async () => {
    await writeFile(join(dir, 'target.txt'), 'target')
    await symlink('target.txt', join(dir, 'link.txt'))
    expect((await host.stat(localPath(join(dir, 'link.txt')))).type).toBe('symlink')
  })

  it('emits watch events on file creation', { timeout: 10000 }, async () => {
    const events: WatchEvent[] = []
    const stop = host.watch(localPath(dir), (e) => events.push(e))
    await delay(400) // let chokidar finish its initial scan
    await writeFile(join(dir, 'watched.txt'), 'v1')
    await waitFor(() => events.some((e) => e.type === 'add'))
    await stop()
    const added = events.find((e) => e.type === 'add')
    expect(added?.path.path.endsWith('watched.txt')).toBe(true)
    expect(added?.path.hostId).toBe(host.hostId)
  })

  it(
    'prunes excluded directory names from recursive watches',
    { timeout: 10000 },
    async () => {
      const ignored = join(dir, 'node_modules')
      const visible = join(dir, 'src')
      await mkdir(ignored)
      await mkdir(visible)
      const events: WatchEvent[] = []
      const stop = host.watch(localPath(dir), (event) => events.push(event), {
        excludeDirectoryNames: ['node_modules'],
      })
      await delay(400)

      await writeFile(join(ignored, 'ignored.js'), 'ignored')
      await writeFile(join(visible, 'visible.js'), 'visible')
      await waitFor(() => events.some((event) => event.path.path.endsWith('visible.js')))
      await delay(200)
      await stop()

      expect(events.some((event) => event.path.path.includes('node_modules'))).toBe(false)
    },
  )
})
