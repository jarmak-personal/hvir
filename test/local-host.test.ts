import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalHost } from '../src/main/project-host/local-host'
import { MAX_EXEC_STREAM_WRITE_BYTES } from '../src/main/project-host/project-host'
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

  it('preserves an externally changed file when an atomic save is stale', async () => {
    const p = localPath(join(dir, 'conflict.txt'))
    await host.writeFile(p, 'original')
    const opened = await host.stat(p)
    await writeFile(p.path, 'external')
    const changedTime = new Date(opened.mtimeMs + 10_000)
    await utimes(p.path, changedTime, changedTime)

    await expect(
      host.writeFile(p, 'mine', { expectedMtimeMs: opened.mtimeMs }),
    ).rejects.toThrow('changed since it was opened')
    expect(await host.readTextFile(p)).toBe('external')
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

  it('decodes multibyte output split across process chunks', async () => {
    const script = [
      'process.stdout.write(Buffer.from([0xe2]))',
      'setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 20)',
    ].join(';')
    const result = await host.exec(process.execPath, ['-e', script])

    expect(result.stdout).toBe('€')
    expect(result.stdout).not.toContain('�')
  })

  it('decodes multibyte streaming output split across chunks', async () => {
    const script = [
      'process.stdout.write(Buffer.from([0xf0, 0x9f]))',
      'setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 20)',
    ].join(';')
    const stream = host.execStream(process.execPath, ['-e', script])
    let stdout = ''
    stream.onStdout((chunk) => {
      stdout += chunk
    })
    await new Promise<void>((resolve, reject) => {
      stream.onError(reject)
      stream.onExit(() => resolve())
    })

    expect(stdout).toBe('😀')
    stream.dispose()
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

  it('supports bounded duplex streaming when explicitly requested', async () => {
    const stream = host.execStream('cat', [], { keepStdinOpen: true })
    let stdout = ''
    stream.onStdout((chunk) => {
      stdout += chunk
    })
    const exited = new Promise<void>((resolve, reject) => {
      stream.onError(reject)
      stream.onExit(() => resolve())
    })

    await stream.write('first ')
    await stream.end('second')
    await exited

    expect(stdout).toBe('first second')
    stream.dispose()
  })

  it('rejects oversized or unrequested streaming stdin writes', async () => {
    const closed = host.execStream('cat', [])
    await expect(closed.write('unexpected')).rejects.toThrow('stdin is not open')
    closed.dispose()

    const duplex = host.execStream('cat', [], { keepStdinOpen: true })
    await expect(
      duplex.write('x'.repeat(MAX_EXEC_STREAM_WRITE_BYTES + 1)),
    ).rejects.toThrow('byte limit')
    await duplex.end()
    duplex.dispose()
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

  it('browses a symlinked directory after resolving its in-project target', async () => {
    await mkdir(join(dir, 'target'))
    await writeFile(join(dir, 'target', 'inside.txt'), 'visible')
    await symlink('target', join(dir, 'linked'), 'dir')
    const link = localPath(join(dir, 'linked'))

    expect((await host.stat(link)).type).toBe('symlink')
    expect((await host.stat(await host.realpath(link))).type).toBe('dir')
    expect((await host.readdir(link)).map((entry) => entry.name)).toEqual(['inside.txt'])
  })

  it('writes a resolved file target without replacing its symlink', async () => {
    await writeFile(join(dir, 'target.txt'), 'before')
    await symlink('target.txt', join(dir, 'linked.txt'))
    const link = localPath(join(dir, 'linked.txt'))
    const target = await host.realpath(link)

    await host.writeFile(target, 'after')

    expect((await host.stat(link)).type).toBe('symlink')
    expect((await host.readFile(link)).toString('utf8')).toBe('after')
  })

  it('canonicalizes symlinked paths for confinement checks', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hvir-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(dir, 'escape'), 'dir')
    try {
      const canonicalOutside = await realpath(outside)
      expect(
        (await host.realpath(localPath(join(dir, 'escape', 'secret.txt')))).path,
      ).toBe(join(canonicalOutside, 'secret.txt'))
    } finally {
      await rm(outside, { recursive: true })
    }
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
