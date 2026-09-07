import { describe, expect, it, vi } from 'vitest'
import {
  captureSessionTokens,
  type SessionTokenCapturePorts,
} from '../scripts/project-management/session-token-capture.ts'
import type { SessionTokenReceipt } from '../scripts/project-management/session-token-receipts.ts'

function fixture() {
  const receipts: SessionTokenReceipt[] = []
  const ports: SessionTokenCapturePorts = {
    issue: vi.fn<SessionTokenCapturePorts['issue']>((number) =>
      Promise.resolve({
        id: 'unused',
        number,
        repository: 'owner/repo',
        state: 'OPEN',
        updatedAt: 'now',
        labels: number === 733 ? ['kind:epic'] : ['kind:refactor'],
        parent:
          number === 733
            ? null
            : { number: 733, repository: 'owner/repo', state: 'OPEN' },
        subIssues:
          number === 733
            ? [{ number: 757, repository: 'owner/repo', state: 'OPEN' }]
            : [],
        linkedPullRequests: [],
      }),
    ),
    tokens: {
      read: vi.fn((issue) =>
        Promise.resolve({
          receipts: receipts.filter((row) => row.issue === issue),
          legacy: false,
          diagnostics: [],
        }),
      ),
      append: vi.fn((receipt: SessionTokenReceipt) =>
        Promise.resolve().then(() => {
          receipts.push(receipt)
        }),
      ),
    },
    observe: vi.fn<SessionTokenCapturePorts['observe']>(() =>
      Promise.resolve({ tokens: 100 }),
    ),
    assign: vi.fn<SessionTokenCapturePorts['assign']>(() =>
      Promise.resolve({
        issue: 757,
        receipt: 'a'.repeat(64),
      }),
    ),
    project: vi.fn<SessionTokenCapturePorts['project']>().mockResolvedValue(undefined),
  }
  return { ports, receipts }
}
const input = { issue: 757, provider: 'codex' as const, apply: true }

describe('one deterministic token capture operation', () => {
  it('dry-runs with no assignment, receipt or Project mutation', async () => {
    const { ports } = fixture()
    ports.assign = vi.fn(() => Promise.resolve(undefined))
    expect(await captureSessionTokens(ports, { ...input, apply: false })).toEqual({
      capture: 'would-assign-and-record',
      observedTokens: 100,
      diagnostics: [],
    })
    expect(ports.assign).toHaveBeenCalledExactlyOnceWith(false)
    expect(ports.tokens.append).not.toHaveBeenCalled()
    expect(ports.project).not.toHaveBeenCalled()
  })
  it('captures once and retries selected issue and native parent projection without reappending', async () => {
    const { ports, receipts } = fixture()
    ports.project = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValue(undefined)
    const first = await captureSessionTokens(ports, input)
    expect(first).toEqual({
      capture: 'recorded',
      observedTokens: 100,
      diagnostics: ['token-projection-unavailable:#757'],
    })
    expect(ports.project).toHaveBeenCalledWith(733, 100)
    expect((await captureSessionTokens(ports, input)).capture).toBe('unchanged')
    expect(receipts).toHaveLength(1)
    expect(ports.tokens.append).toHaveBeenCalledTimes(1)
  })
  it('keeps existing totals when current usage is unavailable, without unavailable receipts', async () => {
    const { ports, receipts } = fixture()
    await captureSessionTokens(ports, input)
    ports.observe = vi.fn(() => Promise.resolve({ unavailable: 'usage-unavailable' }))
    expect((await captureSessionTokens(ports, input)).capture).toContain(
      'usage-unavailable',
    )
    expect(receipts).toHaveLength(1)
    expect(ports.project).toHaveBeenLastCalledWith(733, 100)
  })
  it('stops a cross-issue assignment before inspecting private provider data or mutating', async () => {
    const { ports } = fixture()
    ports.assign = vi
      .fn()
      .mockRejectedValue(new Error('Session already belongs to another issue.'))
    expect((await captureSessionTokens(ports, input)).capture).toBe(
      'session-already-assigned-to-another-issue',
    )
    expect(ports.observe).not.toHaveBeenCalled()
    expect(ports.project).not.toHaveBeenCalled()
  })
  it('does not clear an existing Project total when all token history is unavailable', async () => {
    const { ports } = fixture()
    ports.observe = vi.fn(() => Promise.resolve({ unavailable: 'usage-unavailable' }))
    ports.tokens.read = vi.fn().mockRejectedValue(new Error('transport'))
    const result = await captureSessionTokens(ports, input)
    expect(result.diagnostics).toContain('token-projection-unavailable:#757')
    expect(ports.project).not.toHaveBeenCalled()
  })
})
