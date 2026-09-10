import { describe, expect, it, vi } from 'vitest'
import {
  captureTokenReceipt,
  isSessionTokenReceipt,
  LEGACY_TOKEN_MARKER,
  readTokenReceipts,
  serializeTokenReceipt,
  totalTokenReceipts,
  type SessionTokenReceipt,
} from '../scripts/project-management/session-token-receipts.ts'

const receipt = (
  tokens = 100,
  overrides: Partial<SessionTokenReceipt> = {},
): SessionTokenReceipt => ({
  schema: 2,
  issue: 757,
  receipt: 'a'.repeat(64),
  provider: 'codex',
  tokens,
  ...overrides,
})
const comment = (body: string) => ({
  body,
  authorLogin: 'owner',
  createdAt: 'now',
  updatedAt: 'now',
})

describe('observed session token receipts', () => {
  it('counts one session once across increases, stale observations and concurrent duplicate appends', () => {
    expect(
      totalTokenReceipts([
        receipt(),
        receipt(),
        receipt(150),
        receipt(75),
        receipt(30, { receipt: 'b'.repeat(64), issue: 758 }),
      ]),
    ).toEqual({ tokens: 180, contributions: 2, diagnostics: [] })
  })
  it('keeps absence unknown, real zero zero, and rejects unsafe aggregate arithmetic', () => {
    expect(totalTokenReceipts([]).tokens).toBeNull()
    expect(totalTokenReceipts([receipt(0)]).tokens).toBe(0)
    expect(
      totalTokenReceipts([
        receipt(Number.MAX_SAFE_INTEGER),
        receipt(1, { receipt: 'b'.repeat(64) }),
      ]).diagnostics,
    ).toEqual(['token-total-overflow'])
  })
  it('does not double count an ambiguous cross-issue or provider assignment', () => {
    expect(
      totalTokenReceipts([receipt(), receipt(150, { issue: 758 })]).tokens,
    ).toBeNull()
    expect(
      totalTokenReceipts([receipt(), receipt(150, { provider: 'claude-code' })]).tokens,
    ).toBeNull()
  })
  it('admits only closed numeric records and does not publish private identity', () => {
    expect(isSessionTokenReceipt(receipt())).toBe(true)
    for (const value of [-1, 1.5, Infinity, NaN])
      expect(isSessionTokenReceipt(receipt(value))).toBe(false)
    expect(isSessionTokenReceipt({ ...receipt(), sessionId: 'private' })).toBe(false)
    expect(serializeTokenReceipt(receipt())).not.toContain('sessionId')
  })
  it('preserves legacy presence without importing old totals; rejects malformed/edited trusted records', () => {
    const body = serializeTokenReceipt(receipt())
    const history = readTokenReceipts(757, 'owner', [
      comment(body),
      comment(`${LEGACY_TOKEN_MARKER}\nold`),
      { ...comment(body), updatedAt: 'later' },
      { ...comment(body), authorLogin: 'other' },
      comment(body.replace('"tokens":100', '"tokens":-1')),
    ])
    expect(history).toEqual({
      receipts: [receipt()],
      legacy: true,
      legacyDiagnostics: ['legacy-evidence-needs-review'],
      diagnostics: ['invalid-token-receipt'],
    })
    expect(readTokenReceipts(758, 'owner', [comment(body)]).receipts).toEqual([])
  })
  it('plans without writing and retries an uncertain append without adding the whole session again', async () => {
    const receipts: SessionTokenReceipt[] = []
    const port = {
      read: vi.fn(() => Promise.resolve({ receipts, legacy: false, diagnostics: [] })),
      append: vi.fn((row: SessionTokenReceipt) =>
        Promise.resolve().then(() => {
          receipts.push(row)
          throw new Error('lost reply')
        }),
      ),
    }
    expect(await captureTokenReceipt(port, receipt(), false)).toBe('would-record')
    expect(port.append).not.toHaveBeenCalled()
    await expect(captureTokenReceipt(port, receipt(), true)).rejects.toThrow('lost reply')
    expect(await captureTokenReceipt(port, receipt(), true)).toBe('unchanged')
    expect(await captureTokenReceipt(port, receipt(90), true)).toBe('unchanged')
    expect(port.append).toHaveBeenCalledTimes(1)
  })
})
