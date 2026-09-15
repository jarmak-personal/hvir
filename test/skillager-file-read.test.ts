import { expect, it, vi } from 'vitest'
import { localPath, type Stat } from '../src/shared'
import { readSkillagerFileBytes } from '../src/main/skillager/skillager-file-read'

const path = localPath('/skill/SKILL.md')
const initial: Stat = { type: 'file', size: 3, mode: 0o644, mtimeMs: 1000 }
function fixture() {
  let after = initial
  const controller = new AbortController()
  const stat = vi.fn(() => Promise.resolve(after))
  const closed = vi.fn()
  let chunks: Uint8Array[] = [Uint8Array.of(1, 2, 3)]
  let during = () => {}
  const readFileChunks = vi.fn(async function* () {
    try {
      for (const chunk of chunks) {
        during()
        yield await Promise.resolve(chunk)
      }
    } finally {
      closed()
    }
  })
  return {
    controller,
    stat,
    closed,
    readFileChunks,
    read: (expectedSize?: number, assertCurrent?: () => void) =>
      readSkillagerFileBytes({ stat, readFileChunks }, path, controller.signal, {
        expectedSize,
        assertCurrent,
      }),
    metadata: (value: Partial<Stat>) => {
      after = { ...initial, ...value }
    },
    stream: (value: Uint8Array[], change = () => {}) => {
      chunks = value
      during = change
    },
  }
}

it('retains owned chunks even when the host reuses and later mutates its buffer', async () => {
  const reused = Uint8Array.of(1, 2)
  const host = {
    stat: () => Promise.resolve({ ...initial, size: 4 }),
    readFileChunks: async function* () {
      yield await Promise.resolve(reused)
      reused.set([3, 4])
      yield await Promise.resolve(reused)
      reused.fill(9)
    },
  }
  expect(await readSkillagerFileBytes(host, path, new AbortController().signal)).toEqual(
    Buffer.from([1, 2, 3, 4]),
  )
})

it.each([
  ['growth', [Uint8Array.of(1, 2, 3, 4)], 'output-limit'],
  ['truncation', [Uint8Array.of(1, 2)], 'stale-review'],
] as const)(
  'rejects stream %s and closes the iterator',
  async (_name, chunks, reason) => {
    const f = fixture()
    f.stream([...chunks])
    await expect(f.read()).rejects.toMatchObject({ reason })
    expect(f.closed).toHaveBeenCalledOnce()
  },
)

it.each([
  ['size', { size: 4 }],
  ['mode', { mode: 0o755 }],
  ['mtime', { mtimeMs: 2000 }],
  ['type', { type: 'dir' as const }],
] as const)(
  'rejects a changed post-stream %s even when all bytes arrived',
  async (_name, change) => {
    const f = fixture()
    f.stream([Uint8Array.of(1, 2, 3)], () => f.metadata(change))
    await expect(f.read()).rejects.toMatchObject({ reason: 'stale-review' })
    expect(f.stat).toHaveBeenCalledTimes(2)
    expect(f.closed).toHaveBeenCalledOnce()
  },
)

it('refuses a changed tree-plan size and oversized file before opening a stream', async () => {
  const f = fixture()
  await expect(f.read(2)).rejects.toMatchObject({ reason: 'stale-review' })
  f.metadata({ size: 8 * 1024 * 1024 + 1 })
  await expect(f.read()).rejects.toMatchObject({ reason: 'output-limit' })
  expect(f.readFileChunks).not.toHaveBeenCalled()
})

it.each(['abort', 'grant'] as const)(
  'rejects %s revocation during streaming and closes the iterator',
  async (kind) => {
    const f = fixture()
    let live = true
    f.stream([Uint8Array.of(1, 2, 3)], () => {
      if (kind === 'abort') f.controller.abort()
      live = false
    })
    await expect(
      f.read(undefined, () => {
        if (!live) throw Error('Document grant revoked')
      }),
    ).rejects.toThrow()
    expect(f.closed).toHaveBeenCalledOnce()
  },
)
