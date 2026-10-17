import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceFixture } from './fixtures/extension-source'
import { SOURCE_LIMITS } from '../src/shared/extensions/source-access'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { localPath, asHostId } from '../src/shared/host-path'
import type { SourceCaller } from '../src/main/extensions/source-reading'
const fixtures: ReturnType<typeof sourceFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose()
  vi.useRealTimers()
})
async function fixture(context: 'application' | 'workspace' = 'application') {
  const f = sourceFixture(context)
  fixtures.push(f)
  await f.grant()
  return f
}
function selected(value: unknown) {
  return value as { receipt: string; bytes: number }
}
function page(value: unknown) {
  return value as { data: string; nextOffset: number | null; encoding: string }
}
function barrier() {
  let resume!: () => void, entered!: () => void
  return {
    blocked: new Promise<void>((r) => {
      resume = r
    }),
    reached: new Promise<void>((r) => {
      entered = r
    }),
    resume: () => resume(),
    entered: () => entered(),
  }
}
function select(f: Awaited<ReturnType<typeof fixture>>, caller = f.caller) {
  return f.reading.select(caller, { source: 'source', path: f.path })
}

describe('selected source lifetime and confinement', () => {
  it('refuses a different or future workspace and checks exact authority through pages, assets and render', async () => {
    const f = sourceFixture('workspace', {
      render: vi.fn(),
      dispose: vi.fn(),
    } as unknown as import('../src/main/viewer/document-markdown-owner').DocumentMarkdownOwner)
    fixtures.push(f)
    await f.grant()
    const other = {
      ...f.caller,
      context: () => ({
        ...f.caller.context()!,
        value: {
          ...f.caller.context()!.value,
          workspace: { id: 'future', name: 'Other', host: 'local' },
        },
      }),
    }
    await expect(select(f, other)).rejects.toThrow(/exact registered/)
    await expect(
      f.reading.select(f.caller, {
        source: 'source',
        path: { ...f.path, hostId: asHostId('ssh') },
      }),
    ).rejects.toThrow()
    expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
    const receipt = selected(await select(f))
    f.workspaces.length = 0
    expect(() => f.reading.read(f.caller, { receipt: receipt.receipt })).toThrow(
      /ended|stale/,
    )
    await expect(
      f.reading.asset(f.caller, { receipt: receipt.receipt, path: 'image.png' }),
    ).rejects.toThrow(/ended|stale/)
    await expect(
      f.reading.render(f.caller, { receipt: receipt.receipt }),
    ).rejects.toThrow(/ended|stale/)
    await expect(select(f)).rejects.toThrow(/Grant/)
  })
  it('reads current selected UTF-8 bytes without consulting accepted snapshots or prefetching', async () => {
    const f = await fixture()
    expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
    const text = '📖 Instructions\n'.repeat(500)
    f.host.readTextFilePrefix.mockResolvedValue({
      content: text,
      complete: true,
      byteLength: Buffer.byteLength(text),
      lineCount: 500,
      validUtf8: true,
    })
    const receipt = selected(await select(f))
    let result = '',
      offset = 0
    for (;;) {
      const next = page(f.reading.read(f.caller, { receipt: receipt.receipt, offset }))
      result += next.data
      if (next.nextOffset === null) break
      offset = next.nextOffset
    }
    expect(result).toBe(text)
    expect(receipt.bytes).toBe(Buffer.byteLength(text))
    expect(() =>
      f.reading.read({ ...f.caller, view: 'other' }, { receipt: receipt.receipt }),
    ).toThrow(/another view/)
    expect(() =>
      f.reading.read(f.caller, { receipt: receipt.receipt, offset: 1 }),
    ).toThrow(/offset/)
  })
  it.each(['agent', 'action', 'updater'])(
    'does not provide bodies to %s origins',
    async () => {
      const f = await fixture()
      await expect(select(f, { ...f.caller, allowed: false })).rejects.toThrow(
        /ordinary human/,
      )
      expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
    },
  )
  it('rejects outside paths, symlink escape and changed roots instead of borrowing external document permission', async () => {
    const f = await fixture()
    await expect(
      f.reading.select(f.caller, {
        source: 'source',
        path: localPath('/elsewhere/SKILL.md'),
      }),
    ).rejects.toThrow()
    f.host.realpath.mockImplementation((value) =>
      Promise.resolve(
        value.path === f.path.path ? localPath('/elsewhere/SKILL.md') : value,
      ),
    )
    await expect(select(f)).rejects.toThrow()
    expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
  })
  it('reads only the exact registered SSH host through the existing owning port', async () => {
    const f = sourceFixture('workspace', undefined, asHostId('ssh:registered'))
    fixtures.push(f)
    await f.grant()
    const receipt = selected(await select(f))
    expect(page(f.reading.read(f.caller, { receipt: receipt.receipt })).data).toBe(
      '# Current instruction',
    )
    expect(f.host.readTextFilePrefix).toHaveBeenCalledWith(
      f.path,
      SOURCE_LIMITS.textBytes,
      expect.any(Object),
    )
    await expect(
      f.reading.select(f.caller, { source: 'source', path: localPath(f.path.path) }),
    ).rejects.toThrow()
    expect(f.host.readTextFilePrefix).toHaveBeenCalledTimes(1)
  })
  it('keeps application source lifetime independent of the active workspace', async () => {
    const f = await fixture(),
      receipt = selected(await select(f))
    const caller = { ...f.caller, context: () => undefined }
    expect(page(f.reading.read(caller, { receipt: receipt.receipt })).data).toBe(
      '# Current instruction',
    )
    const w = await fixture('workspace'),
      b = barrier()
    w.host.readTextFilePrefix.mockImplementationOnce(async () => {
      b.entered()
      await b.blocked
      return {
        content: 'late',
        byteLength: 4,
        lineCount: 1,
        complete: true,
        validUtf8: true,
      }
    })
    const reading = select(w),
      rejected = expect(reading).rejects.toThrow()
    await b.reached
    w.close()
    b.resume()
    await rejected
  })
  it.each(['document', 'asset'] as const)(
    'rejects %s publication after revocation during the final canonical recheck',
    async (resource) => {
      const f = await fixture(),
        b = barrier()
      const parent = resource === 'asset' ? selected(await select(f)) : undefined
      let rechecks = 0
      f.host.realpath.mockImplementation(async (path) => {
        const final =
          resource === 'document'
            ? path.path === f.root.path && ++rechecks === 4
            : path.path === f.path.path && ++rechecks === 2
        if (final) {
          b.entered()
          await b.blocked
        }
        return path
      })
      const reading = parent
        ? f.reading.asset(f.caller, { receipt: parent.receipt, path: 'image.png' })
        : select(f)
      const rejected = expect(reading).rejects.toThrow()
      await b.reached
      const revoking = f.approvals.revoke('installation', 'source')
      b.resume()
      await rejected
      await revoking
    },
  )
  it('prevents late publication after revoke, hidden/closed view and changed canonical path', async () => {
    const f = await fixture(),
      b = barrier()
    f.host.readTextFilePrefix.mockImplementationOnce(async () => {
      b.entered()
      await b.blocked
      return {
        content: 'late',
        byteLength: 4,
        lineCount: 1,
        complete: true,
        validUtf8: true,
      }
    })
    const reading = select(f),
      rejected = expect(reading).rejects.toThrow()
    await b.reached
    await f.approvals.revoke('installation', 'source')
    b.resume()
    await rejected
    expect(() => f.reading.read(f.caller, { receipt: 'guessed' })).toThrow()
  })
  it('retains physical capacity after cancelled non-abortable host reads until they settle', async () => {
    const f = await fixture(),
      b = barrier()
    f.host.readTextFilePrefix.mockImplementation(async () => {
      b.entered()
      await b.blocked
      return {
        content: 'late',
        byteLength: 4,
        lineCount: 1,
        complete: true,
        validUtf8: true,
      }
    })
    const readers: Promise<unknown>[] = []
    for (let index = 0; index < SOURCE_LIMITS.receipts; index++) {
      const caller: SourceCaller = { ...f.caller, view: `view-${index}` }
      const reading = select(f, caller)
      readers.push(reading.catch(() => undefined))
      // Reach the real owning host port before closing the publication lifetime.
      await vi.waitFor(() =>
        expect(f.host.readTextFilePrefix).toHaveBeenCalledTimes(index + 1),
      )
      f.reading.closeView(caller.view)
    }
    await expect(select(f, { ...f.caller, view: 'ninth' })).rejects.toThrow(/capacity/)
    expect(f.host.readTextFilePrefix).toHaveBeenCalledTimes(SOURCE_LIMITS.receipts)
    b.resume()
    await Promise.all(readers)
    await expect(select(f, { ...f.caller, view: 'settled' })).resolves.toMatchObject({
      bytes: 4,
    })
  })
  it('bounds growing images during the host stream and rejects directory/symlink escapes', async () => {
    const f = await fixture(),
      receipt = selected(await select(f))
    const read = f.readImage
    read.mockImplementationOnce(async function* () {
      yield await Promise.resolve(Buffer.alloc(SOURCE_LIMITS.assetBytes))
      yield Buffer.from('growth')
    })
    await expect(
      f.reading.asset(f.caller, { receipt: receipt.receipt, path: 'image.png' }),
    ).rejects.toThrow(/byte limit/)
    await expect(
      f.reading.asset(f.caller, { receipt: receipt.receipt, path: '../image.png' }),
    ).rejects.toThrow(/escapes/)
    await expect(
      f.reading.asset(f.caller, {
        receipt: receipt.receipt,
        path: 'https://example.com/image.png',
      }),
    ).rejects.toThrow(/relative/)
    f.host.realpath.mockImplementation((value) =>
      Promise.resolve(
        value.path.endsWith('image.png')
          ? localPath('/library/elsewhere/image.png')
          : value,
      ),
    )
    await expect(
      f.reading.asset(f.caller, { receipt: receipt.receipt, path: 'image.png' }),
    ).rejects.toThrow(/symlink/)
  })
  it('reclaims idle expired receipts and completes maximum text and image pages within real transport pacing', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const text = '\u0000'.repeat(SOURCE_LIMITS.textBytes)
    f.host.readTextFilePrefix.mockResolvedValue({
      content: text,
      complete: true,
      byteLength: text.length,
      lineCount: 1,
      validUtf8: true,
    })
    const receipt = selected(await select(f))
    let offset = 0,
      bytes = 0,
      requests = 0
    for (;;) {
      const next = page(f.reading.read(f.caller, { receipt: receipt.receipt, offset }))
      bytes += Buffer.byteLength(next.data)
      requests++
      const envelope = {
        kind: 'result',
        id: 'x'.repeat(80),
        ok: true,
        value: next,
        warnings: Array.from({ length: EXTENSION_LIMITS.warnings }, () =>
          'x'.repeat(160),
        ),
      }
      expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
        EXTENSION_LIMITS.messageBytes,
      )
      vi.advanceTimersByTime(40)
      if (next.nextOffset === null) break
      offset = next.nextOffset
    }
    expect(bytes).toBe(SOURCE_LIMITS.textBytes)
    const read = f.readImage
    read.mockImplementationOnce(async function* () {
      yield await Promise.resolve(Buffer.alloc(SOURCE_LIMITS.assetBytes))
    })
    const asset = selected(
      await f.reading.asset(f.caller, { receipt: receipt.receipt, path: 'image.png' }),
    )
    offset = 0
    let encoded = ''
    for (;;) {
      const next = page(f.reading.read(f.caller, { receipt: asset.receipt, offset }))
      encoded += next.data
      requests++
      vi.advanceTimersByTime(40)
      if (next.nextOffset === null) break
      offset = next.nextOffset
    }
    expect(Buffer.from(encoded, 'base64').length).toBe(SOURCE_LIMITS.assetBytes)
    expect(requests * 40).toBeLessThan(SOURCE_LIMITS.receiptMs)
    vi.advanceTimersByTime(SOURCE_LIMITS.receiptMs)
    expect(() => f.reading.read(f.caller, { receipt: receipt.receipt })).toThrow(/stale/)
    expect(() => f.reading.read(f.caller, { receipt: asset.receipt })).toThrow(/stale/)
    // Expiry does not wait for a later prune request before reclaiming admission.
    await expect(select(f)).resolves.toMatchObject({ bytes: SOURCE_LIMITS.textBytes })
  })
})
