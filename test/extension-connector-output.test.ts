import { afterEach, expect, it, vi } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { CONNECTOR_LIMITS } from '../src/shared/extensions/connectors'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'

const fixtures: ReturnType<typeof connectorFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose()
  vi.useRealTimers()
})
async function fixture(stdout: string, stderr = '') {
  const f = connectorFixture()
  fixtures.push(f)
  await f.approve()
  f.host.exec.mockResolvedValue({ code: 17, signal: null, stdout, stderr })
  const result = await f.execution.execute(f.caller, f.input)
  return {
    ...f,
    result,
    read: (offset: number, stream = 'stdout') =>
      f.execution.output(f.caller, { receipt: result.receipt, stream, offset })!,
  }
}
it.each(['a', '\u0001', '\\"', 'é😀中'])(
  'delivers complete %j UTF-8 streams inside the output-only envelope with a bounded raw page',
  async (unit) => {
    const stdout = unit.repeat(Math.ceil((650 * 1024) / Buffer.byteLength(unit))),
      stderr = '😀'.repeat(32769)
    const f = await fixture(stdout, stderr)
    let pages = 0
    for (const [stream, expected] of [
      ['stdout', stdout],
      ['stderr', stderr],
    ]) {
      let offset: number | null = 0,
        actual = ''
      while (offset !== null) {
        const page = f.read(offset, stream)
        const bytes = Buffer.byteLength(page.data)
        expect(bytes).toBeLessThanOrEqual(CONNECTOR_LIMITS.pageBytes)
        const encoded = Buffer.byteLength(
          JSON.stringify({
            kind: 'result',
            id: '\u0001'.repeat(80),
            ok: true,
            value: page,
            warnings: Array(EXTENSION_LIMITS.warnings).fill(
              'Ignored unknown field: ' + '\u0001'.repeat(80),
            ),
          }),
        )
        expect(encoded).toBeLessThanOrEqual(CONNECTOR_LIMITS.outputReplyBytes)
        if (pages === 0) expect(encoded).toBeGreaterThan(EXTENSION_LIMITS.messageBytes)
        if (page.nextOffset !== null) {
          expect(bytes).toBeGreaterThanOrEqual(64 * 1024 - 3)
          expect(page.nextOffset).toBe(offset + bytes)
        }
        expect(page.result).toEqual(f.result)
        actual += page.data
        offset = page.nextOffset
        pages++
      }
      expect(actual).toBe(expected)
    }
    expect(pages).toBeLessThanOrEqual(14)
    expect(f.read(Buffer.byteLength(stdout))).toMatchObject({
      data: '',
      nextOffset: null,
    })
    expect(() => f.read(0)).toThrow('allowance exhausted')
    expect(
      f.execution.output(f.caller, { receipt: f.result.receipt, release: true }),
    ).toBeNull()
  },
)
it('reserves worst-escaped warning keys when a nominal page nearly fills the encoded envelope', async () => {
  const f = await fixture('\u0001'.repeat(78_000) + 'a'.repeat(128 * 1024 - 78_000))
  const page = f.read(0)
  // This mixture fits with ASCII-only warning placeholders but exceeds the full
  // encoded envelope when sixteen permitted unknown keys require JSON escaping.
  expect(Buffer.byteLength(page.data)).toBeLessThan(128 * 1024)
  const reply = {
    kind: 'result',
    id: 'x'.repeat(80),
    ok: true,
    value: page,
    warnings: Array.from(
      { length: 16 },
      (_, index) =>
        'Ignored unknown field: ' + '\u0001'.repeat(79) + String.fromCharCode(index + 1),
    ),
  }
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(512 * 1024)
})
it('charges overlapping and repeated reads before delivery without silently shortening pages', async () => {
  const f = await fixture('x'.repeat(3 * CONNECTOR_LIMITS.pageBytes))
  expect(f.read(0).data.length).toBe(CONNECTOR_LIMITS.pageBytes)
  expect(f.read(0).data.length).toBe(CONNECTOR_LIMITS.pageBytes)
  // One page is left, even though these offsets overlap previously returned data.
  expect(f.read(CONNECTOR_LIMITS.pageBytes / 2).data.length).toBe(
    CONNECTOR_LIMITS.pageBytes,
  )
  expect(() => f.read(2 * CONNECTOR_LIMITS.pageBytes)).toThrow('allowance exhausted')
  expect(() => f.read(1)).toThrow('allowance exhausted')
})
it('refuses a page exceeding the remaining allowance in full and leaves smaller valid ranges available', async () => {
  const f = await fixture('x'.repeat(CONNECTOR_LIMITS.pageBytes + 1))
  f.read(0)
  expect(() => f.read(0)).toThrow('allowance exhausted')
  expect(f.read(CONNECTOR_LIMITS.pageBytes)).toMatchObject({
    data: 'x',
    nextOffset: null,
  })
})
it('does not charge invalid offsets or sibling authority, and preserves capture custody after complete public consumption', async () => {
  const f = await fixture('😀text')
  // Capture needs a successful native result, independent of the public allowance.
  f.host.exec.mockResolvedValue({ code: 0, signal: null, stdout: '😀text', stderr: '' })
  const caller = { ...f.caller, action: 'capture' }
  const result = await f.execution.execute(caller, f.input)
  for (const other of [
    { ...caller, action: 'other' },
    { ...caller, view: 'sibling' },
    { ...caller, activation: { ...caller.activation } },
  ])
    expect(() =>
      f.execution.output(other, { receipt: result.receipt, stream: 'stdout', offset: 0 }),
    ).toThrow('another caller')
  expect(() =>
    f.execution.output(caller, { receipt: result.receipt, stream: 'stdout', offset: 1 }),
  ).toThrow('UTF-8')
  expect(
    f.execution.output(caller, { receipt: result.receipt, stream: 'stdout', offset: 0 })
      ?.data,
  ).toBe('😀text')
  expect(() => f.execution.assertCaptureReceipt(caller, result.receipt)).not.toThrow()
  expect(() =>
    f.execution.output(caller, { receipt: result.receipt, stream: 'stdout', offset: 0 }),
  ).toThrow('allowance exhausted')
  expect(() => f.execution.assertCaptureReceipt(caller, result.receipt)).not.toThrow()
  expect(() =>
    f.execution.assertCaptureReceipt({ ...caller, action: 'sibling' }, result.receipt),
  ).toThrow('another caller')
  f.execution.output(caller, { receipt: result.receipt, release: true })
  expect(() => f.execution.assertCaptureReceipt(caller, result.receipt)).toThrow('stale')
})
it('reads never refresh the fixed receipt expiry, and revoked custody cannot be restored', async () => {
  vi.useFakeTimers()
  const f = await fixture('x'.repeat(2 * CONNECTOR_LIMITS.pageBytes))
  await vi.advanceTimersByTimeAsync(29_999)
  f.read(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(() => f.read(CONNECTOR_LIMITS.pageBytes)).toThrow('stale')
  const next = await f.execution.execute({ ...f.caller, action: 'new' }, f.input)
  f.execution.revoke(f.activation.installationId)
  expect(() =>
    f.execution.output(
      { ...f.caller, action: 'new' },
      { receipt: next.receipt, stream: 'stdout', offset: 0 },
    ),
  ).toThrow('stale')
})
