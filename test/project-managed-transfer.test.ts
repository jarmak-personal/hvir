import { expect, it, vi } from 'vitest'
import { managedTransfer } from '../src/main/project-host/managed-transfer'
import { hostPath, asHostId } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
function fixture() {
  const id = asHostId('ssh:test'),
    path = hostPath(id, '/workspace/space and "quote'),
    stat = vi.fn<ProjectHost['stat']>(() =>
      Promise.resolve({
        type: 'dir',
        mode: 0o755,
        size: 0,
        mtimeMs: 0,
      }),
    ),
    result = {
      stdout: '1:123:2026-10-04 01:02:03.123456789 +0000\n',
      stderr: '',
      code: 0,
      signal: null,
      outputTruncated: false,
    },
    tryExec = vi.fn(() => Promise.resolve(result)),
    write = vi.fn(() => Promise.resolve()),
    set = vi.fn(() => Promise.resolve())
  const transfer = managedTransfer(
    {
      hostId: id,
      stat,
      finiteExec: { tryExec },
    },
    write,
    set,
  )
  return { id, path, stat, result, tryExec, transfer, write, set }
}
it.each(['1:123:2026-10-04 01:02:03.123456789 +0000\n', '1:123:1785342963.585397958\n'])(
  'accepts the complete supported native directory witness %s through finite argv execution',
  async (stdout) => {
    const f = fixture()
    f.result.stdout = stdout
    expect(await f.transfer.entryIdentity(f.path)).toBe(stdout.trim())
    expect(f.tryExec).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', expect.stringContaining('%.9FB'), 'hvir-managed-identity', f.path.path],
      { signal: undefined, maxBuffer: 128 },
    )
    expect(f.stat).toHaveBeenCalledTimes(2)
  },
)
it.each([
  '1:123:0\n',
  '1:123:-\n',
  '1:123:1785342963\n',
  '1:123:1785342963.1\n',
  'diagnostic\n1:123:1785342963.585397958\n',
])('refuses unavailable, coarse or non-complete identity %s', async (stdout) => {
  const f = fixture()
  f.result.stdout = stdout
  await expect(f.transfer.entryIdentity(f.path)).rejects.toThrow(/identity/)
})
it('refuses truncated, failed, replaced, foreign-host and canceled observations', async () => {
  const f = fixture()
  f.result.outputTruncated = true
  await expect(f.transfer.entryIdentity(f.path)).rejects.toThrow()
  f.result.outputTruncated = false
  f.result.code = 78
  await expect(f.transfer.entryIdentity(f.path)).rejects.toThrow()
  f.result.code = 0
  f.stat
    .mockResolvedValueOnce({ type: 'dir', mode: 0o755, size: 0, mtimeMs: 0 })
    .mockResolvedValueOnce({ type: 'symlink', mode: 0o755, size: 0, mtimeMs: 0 })
  await expect(f.transfer.entryIdentity(f.path)).rejects.toThrow(/changed/)
  await expect(
    f.transfer.entryIdentity(hostPath(asHostId('other'), f.path.path)),
  ).rejects.toThrow(/host/)
  const controller = new AbortController()
  controller.abort()
  await expect(f.transfer.entryIdentity(f.path, controller.signal)).rejects.toThrow()
})
it('delivers only exact ordinary POSIX bits without broadening ordinary Files modes', async () => {
  const f = fixture()
  const chunks = (async function* () {
    yield await Promise.resolve(Buffer.from('bytes'))
  })()
  await f.transfer.writeFileChunksExclusive(f.path, chunks, { mode: 0o664 })
  expect(f.write).toHaveBeenCalledWith(f.path, chunks, { mode: 0o664 })
  await f.transfer.setMetadata(f.path, { mode: 0o775, mtimeSeconds: 1 })
  expect(f.set).toHaveBeenCalledWith(f.path, { mode: 0o775, mtimeSeconds: 1 })
  await expect(
    f.transfer.setMetadata(f.path, { mode: 0o4755, mtimeSeconds: 1 }),
  ).rejects.toThrow(/ordinary/)
  await expect(
    f.transfer.writeFileChunksExclusive(hostPath(asHostId('other'), '/file'), chunks, {
      mode: 0o644,
    }),
  ).rejects.toThrow(/host/)
})
