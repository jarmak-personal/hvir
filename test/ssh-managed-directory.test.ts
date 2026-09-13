import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
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
  } satisfies ExecStreamHandle
  const execStream = vi.fn(
    (_command: string, _args: readonly string[], _options?: ExecOptions) => stream,
  )
  return {
    port: new SshManagedDirectory({ hostId: root.hostId, execStream }, () => {}),
    execStream,
    events,
    writes,
    dispose,
    stream,
  }
}
describe('managed directory immediate stream boundary', () => {
  it.each([false, true])(
    'requires explicit post-error no-effect proof for submitted unavailability (%s)',
    async (noEffects) => {
      const boundary = transport((events) => {
        events.emit(
          'stdout',
          '{"status":"submitting"}\n' +
            JSON.stringify({ status: 'unavailable', noEffects }) +
            '\n',
        )
        events.emit('exit', { code: 0 })
      })
      const candidate = { ...location, entry: '.stage', tree, device: '1', inode: '2' }
      await expect(
        boundary.port.commit(
          { action: 'add', candidate, target: 'skill' },
          { signal: new AbortController().signal, onSubmitted: () => {} },
        ),
      ).rejects.toMatchObject({ reason: noEffects ? 'unavailable' : 'uncertain' })
    },
  )
  it('allows a validated large stage beyond the ordinary deadline and still enforces its hard bound', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const boundary = transport(() => {})
    const bytes = new Map(
      Array.from(
        { length: 5 },
        (_, index) =>
          [String(index), Buffer.alloc((index === 4 ? 1 : 8) * 1024 * 1024)] as const,
      ),
    )
    const large = {
      files: [...bytes].map(([entry, value]) => ({
        entry,
        size: value.byteLength,
        mode: 0o644 as const,
        sha256: createHash('sha256').update(value).digest('hex'),
      })),
    }
    const pending = boundary.port.stage(
      root,
      '.stage',
      large,
      bytes,
      location,
      new AbortController().signal,
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'uncertain' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(boundary.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300_000 - 30_001)
    await rejected
    expect(boundary.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['write', 'end', 'exit'] as const)(
    'cancels an opened stream with stalled %s and bounds disposal',
    async (at) => {
      const boundary = transport(() => {})
      if (at === 'write')
        vi.mocked(boundary.stream.write).mockImplementation(() => new Promise(() => {}))
      if (at === 'end')
        vi.mocked(boundary.stream.end).mockImplementation(() => new Promise(() => {}))
      const abort = new AbortController()
      const pending = boundary.port.inspectMany(
        root,
        [{ entry: '.stage', tree }],
        abort.signal,
      )
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() =>
        expect(
          at === 'write' ? boundary.stream.write : boundary.stream.end,
        ).toHaveBeenCalled(),
      )
      expect(() => abort.abort()).not.toThrow()
      await rejected
      expect(boundary.stream.kill).toHaveBeenCalledOnce()
      expect(boundary.dispose).toHaveBeenCalledOnce()
      expect(boundary.events.eventNames()).toEqual([])
    },
  )
  it('bounds an opened observation by its deadline even without an exit event', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const boundary = transport(() => {})
    const pending = boundary.port.inspect(
      root,
      '.stage',
      tree,
      new AbortController().signal,
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'unavailable' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(boundary.stream.kill).toHaveBeenCalledOnce()
    expect(boundary.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains submitted uncertainty when aborting a stalled end and cleanup throws', async () => {
    const boundary = transport(() => {})
    vi.mocked(boundary.stream.end).mockImplementation(() => {
      boundary.events.emit('stdout', '{"status":"submitting"}\n')
      return new Promise(() => {})
    })
    vi.mocked(boundary.stream.kill).mockImplementation(() => {
      throw Error('kill failed')
    })
    boundary.dispose.mockImplementation(() => {
      throw Error('dispose failed')
    })
    const abort = new AbortController()
    const candidate = { ...location, entry: '.stage', tree, device: '1', inode: '2' }
    const submitted = vi.fn()
    const pending = boundary.port.commit(
      { action: 'add', candidate, target: 'skill' },
      { signal: abort.signal, onSubmitted: submitted },
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'uncertain' })
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledOnce())
    expect(() => abort.abort()).not.toThrow()
    await rejected
    expect(boundary.stream.kill).toHaveBeenCalledOnce()
    expect(boundary.dispose).toHaveBeenCalledOnce()
    expect(boundary.events.eventNames()).toEqual([])
  })
  it('stops uploading between chunks after cancellation', async () => {
    const boundary = transport(() => {})
    const abort = new AbortController()
    let writes = 0
    vi.mocked(boundary.stream.write).mockImplementation(() => {
      if (writes === 0) boundary.events.emit('stdout', '{"status":"ready"}\n')
      if (++writes === 2) abort.abort()
      return Promise.resolve()
    })
    const bytes = Buffer.alloc(150_000)
    const content = {
      files: [
        {
          entry: 'SKILL.md',
          size: bytes.length,
          mode: 0o644 as const,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    await expect(
      boundary.port.stage(
        root,
        '.stage',
        content,
        new Map([['SKILL.md', bytes]]),
        location,
        abort.signal,
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(writes).toBe(2)
    expect(boundary.stream.end).not.toHaveBeenCalled()
    expect(boundary.dispose).toHaveBeenCalledOnce()
  })
  it('waits for stage admission and preserves a clean terminal refusal without uploading bytes', async () => {
    const boundary = transport(() => {})
    vi.mocked(boundary.stream.write).mockImplementation(() => Promise.resolve())
    const pending = boundary.port.stage(
      root,
      '.stage',
      tree,
      new Map([['SKILL.md', Buffer.alloc(0)]]),
      location,
      new AbortController().signal,
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'refused' })
    await vi.waitFor(() => expect(boundary.stream.write).toHaveBeenCalledOnce())
    expect(boundary.stream.end).not.toHaveBeenCalled()
    boundary.events.emit('stdout', '{"status":"not-applied"}\n')
    boundary.events.emit('exit', { code: 0 })
    await rejected
    expect(boundary.stream.write).toHaveBeenCalledOnce()
    expect(boundary.stream.end).not.toHaveBeenCalled()
    expect(boundary.dispose).toHaveBeenCalledOnce()
  })
  it('cancels a stage while waiting for readiness without further writes', async () => {
    const boundary = transport(() => {}),
      abort = new AbortController()
    const pending = boundary.port.stage(
      root,
      '.stage',
      tree,
      new Map([['SKILL.md', Buffer.alloc(0)]]),
      location,
      abort.signal,
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'uncertain' })
    await vi.waitFor(() => expect(boundary.stream.write).toHaveBeenCalledOnce())
    abort.abort()
    await rejected
    expect(boundary.stream.write).toHaveBeenCalledOnce()
    expect(boundary.stream.end).not.toHaveBeenCalled()
    expect(boundary.dispose).toHaveBeenCalledOnce()
  })
  it('preserves a successful exit emitted before end finishes settling', async () => {
    const boundary = transport(() => {})
    let finish!: () => void
    vi.mocked(boundary.stream.end).mockImplementation(() => {
      boundary.events.emit(
        'stdout',
        JSON.stringify({ status: 'absent', location }) + '\n',
      )
      boundary.events.emit('exit', { code: 0 })
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const pending = boundary.port.inspect(
      root,
      '.stage',
      tree,
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await pending).toEqual({ status: 'absent', location })
    expect(boundary.stream.kill).not.toHaveBeenCalled()
    expect(boundary.dispose).toHaveBeenCalledOnce()
    finish()
  })
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
