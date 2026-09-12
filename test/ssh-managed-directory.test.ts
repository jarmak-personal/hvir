import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { hostPath, asHostId } from '../src/shared'
import { SshManagedDirectory } from '../src/main/project-host/ssh-managed-directory'
import { MANAGED_DIRECTORY_PROGRAM } from '../src/main/project-host/ssh-managed-directory-operations'
import type { ExecOptions, ExecStreamHandle } from '../src/main/project-host/project-host'
import type {
  ManagedDirectoryFile,
  ManagedDirectoryTree,
} from '../src/main/project-host/managed-directory'

const root = hostPath(asHostId('fixture'), '/workspace')
const location = {
  root,
  rootDevice: '1',
  rootInode: '3',
  ancestors: [],
  missingParents: [],
}
const emptyHash = createHash('sha256').update('').digest('hex')
const tree: ManagedDirectoryTree = {
  files: [{ entry: 'SKILL.md', mode: 0o644, size: 0, sha256: emptyHash }],
}
function transport(finish: (events: EventEmitter, input: string) => void) {
  const events = new EventEmitter(),
    writes: string[] = [],
    dispose = vi.fn()
  const subscribe =
    (name: string) =>
    <T>(listener: (value: T) => void) => {
      events.on(name, listener)
      return () => {
        events.off(name, listener)
      }
    }
  const stream = {
    onStdout: subscribe('stdout'),
    onStderr: subscribe('stderr'),
    onError: subscribe('error'),
    onExit: subscribe('exit'),
    write: vi.fn(async (data: string) => {
      await Promise.resolve()
      writes.push(Buffer.from(data).toString('utf8'))
    }),
    end: vi.fn(async () => {
      await Promise.resolve()
      finish(events, writes.join(''))
    }),
    kill: vi.fn(),
    dispose,
  } as ExecStreamHandle
  const execStream = vi.fn(
    (_command: string, _args: readonly string[], _options?: ExecOptions) => stream,
  )
  return {
    port: new SshManagedDirectory({ hostId: root.hostId, execStream }, () => {}),
    execStream,
    events,
    writes,
    dispose,
  }
}
describe('managed directory immediate stream boundary', () => {
  it('uses the fixed host program and preserves a Unicode scalar across a bounded header write', async () => {
    const files: ManagedDirectoryFile[] = []
    while (
      JSON.stringify({ operation: 'inspect', root, entry: '.stage', tree: { files } })
        .length < 16_000
    )
      files.push({
        entry: `${files.length}-${'a'.repeat(140)}`,
        mode: 0o644,
        size: 0,
        sha256: emptyHash,
      })
    let selected: ManagedDirectoryTree | undefined
    for (let length = 0; length < 255; length++) {
      const candidate = {
        files: [
          ...files,
          {
            entry: `${'b'.repeat(length)}😀`,
            mode: 0o644 as const,
            size: 0,
            sha256: emptyHash,
          },
        ],
      }
      const header =
        JSON.stringify({ operation: 'inspect', root, entry: '.stage', tree: candidate }) +
        '\n'
      if (header.indexOf('😀') === 16_383) selected = candidate
    }
    expect(selected).toBeDefined()
    const boundary = transport((events, input) => {
      expect(JSON.parse(input)).toEqual({
        operation: 'inspect',
        root,
        entry: '.stage',
        tree: selected,
      })
      events.emit('stdout', JSON.stringify({ status: 'absent', location }) + '\n')
      events.emit('exit', { code: 0 })
    })
    expect(
      await boundary.port.inspect(root, '.stage', selected!, AbortSignal.timeout(1000)),
    ).toEqual({ status: 'absent', location })
    expect(boundary.writes.every((value) => Buffer.byteLength(value) <= 256 * 1024)).toBe(
      true,
    )
    expect(boundary.execStream.mock.calls[0]!.slice(0, 2)).toEqual([
      'python3',
      ['-c', MANAGED_DIRECTORY_PROGRAM],
    ])
    expect(boundary.dispose).toHaveBeenCalledOnce()
  })
  it('does not dispatch foreign paths, mismatched buffers, or pre-cancelled work', async () => {
    const boundary = transport(() => {
      throw Error('must not dispatch')
    })
    await expect(
      boundary.port.inspect(
        hostPath(asHostId('other'), '/workspace'),
        '.stage',
        tree,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ reason: 'refused' })
    await expect(
      boundary.port.stage(
        root,
        '.stage',
        tree,
        new Map([['SKILL.md', Buffer.from('wrong')]]),
        location,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ reason: 'refused' })
    await expect(
      boundary.port.inspect(root, '.stage', tree, AbortSignal.abort()),
    ).rejects.toBeDefined()
    expect(boundary.execStream).not.toHaveBeenCalled()
  })
  it('bounds stdout and stderr independently and retains unknown outcomes', async () => {
    for (const channel of ['stdout', 'stderr']) {
      const boundary = transport((events) => {
        events.emit(
          channel,
          'x'.repeat(channel === 'stdout' ? 2 * 1024 * 1024 + 1 : 64 * 1024 + 1),
        )
        events.emit('exit', { code: 0 })
      })
      await expect(
        boundary.port.inspect(root, '.stage', tree, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ reason: 'uncertain' })
      expect(boundary.dispose).toHaveBeenCalledOnce()
    }
  })
  it('distinguishes an action-scoped missing prerequisite from a lost submitted commit', async () => {
    const missing = transport((events) => events.emit('exit', { code: 127 }))
    await expect(
      missing.port.inspect(root, '.stage', tree, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ reason: 'unavailable' })
    const submitted = vi.fn(),
      boundary = transport((events) => {
        events.emit('stdout', '{"status":"submitting"}\n')
        events.emit('error', Error('host lost'))
      })
    const candidate = {
      root,
      entry: '.stage',
      tree,
      device: '1',
      inode: '2',
      rootDevice: '1',
      rootInode: '3',
      ancestors: [],
    }
    await expect(
      boundary.port.commit(
        { action: 'add', candidate, target: 'lib-fixture' },
        { signal: AbortSignal.timeout(1000), onSubmitted: submitted },
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(submitted).toHaveBeenCalledOnce()
  })
})
