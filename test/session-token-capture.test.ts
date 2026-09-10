import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assignSession,
  allocateSessionUsage,
} from '../scripts/agent-work-checkpoint-store.mts'
import {
  captureSessionTokens,
  type SessionTokenCapturePorts,
} from '../scripts/project-management/session-token-capture.ts'
import {
  phasedTokenReceipts,
  type SessionTokenReceipt,
} from '../scripts/project-management/session-token-receipts.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'hvir-allocation-'))
  roots.push(temporary)
  const root = join(temporary, 'private')
  const receipts: SessionTokenReceipt[] = []
  let observed = 1000
  const ports: SessionTokenCapturePorts = {
    issue: (number) =>
      Promise.resolve({
        id: 'unused',
        number,
        repository: 'owner/repo',
        state: 'OPEN',
        updatedAt: 'now',
        labels: number === 733 ? ['kind:epic'] : ['kind:maintenance'],
        parent:
          number === 733
            ? null
            : { number: 733, repository: 'owner/repo', state: 'OPEN' },
        subIssues:
          number === 733
            ? [757, 758, 759].map((number) => ({
                number,
                repository: 'owner/repo',
                state: 'OPEN' as const,
              }))
            : [],
        linkedPullRequests: [],
      }),
    tokens: {
      read: (issue) =>
        Promise.resolve({
          receipts: receipts.filter((row) => row.issue === issue),
          legacy: false,
          diagnostics: [],
        }),
      append: vi.fn((row: SessionTokenReceipt) =>
        Promise.resolve().then(() => {
          receipts.push(row)
        }),
      ),
    },
    assign: (apply) =>
      assignSession({
        root,
        repository: 'owner/repo',
        provider: 'codex',
        session: 'private-session',
        issue: 757,
        shared: true,
        apply,
      }),
    allocate: (input) => allocateSessionUsage({ ...input, root }),
    observe: vi.fn(() => Promise.resolve({ tokens: observed })),
    project: vi.fn(() => Promise.resolve()),
  }
  return {
    ports,
    receipts,
    root,
    temporary,
    observe: (value: number) => {
      observed = value
    },
  }
}
const input = {
  issue: 757,
  provider: 'codex' as const,
  phase: 'planning' as const,
  apply: true,
}

describe('durable session allocation and capture', () => {
  it('previews equal shares without creating private state or publishing', async () => {
    const f = await fixture()
    expect(
      await captureSessionTokens(f.ports, { ...input, issues: [758, 757], apply: false }),
    ).toMatchObject({
      capture: 'would-record',
      shares: [
        { issue: 757, tokens: 500 },
        { issue: 758, tokens: 500 },
      ],
    })
    expect(await readdir(f.temporary)).toEqual([])
    expect(f.receipts).toEqual([])
    expect(f.ports.project).not.toHaveBeenCalled()
  })
  it('preserves uneven shares and allocates a later issue only the new counter difference', async () => {
    const f = await fixture()
    f.observe(1001)
    await captureSessionTokens(f.ports, { ...input, issues: [758, 757] })
    expect(f.receipts.map((row) => [row.issue, row.tokens])).toEqual([
      [757, 501],
      [758, 500],
    ])
    expect(
      (await captureSessionTokens(f.ports, { ...input, issues: [757, 758] })).capture,
    ).toBe('unchanged')
    f.observe(1201)
    await captureSessionTokens(f.ports, { ...input, issue: 759 })
    expect(f.receipts.map((row) => [row.issue, row.tokens])).toEqual([
      [757, 501],
      [758, 500],
      [759, 200],
    ])
    expect(f.ports.project).toHaveBeenLastCalledWith(
      733,
      expect.objectContaining({ tokens: 1201, planning: 1201, implementation: 0 }),
    )
  })
  it('replays interrupted batch publication before adding new usage and retries Project failure', async () => {
    const f = await fixture()
    let fail = true
    f.ports.tokens.append = vi.fn((row: SessionTokenReceipt) =>
      Promise.resolve().then(() => {
        f.receipts.push(row)
        if (fail) {
          fail = false
          throw new Error('lost response')
        }
      }),
    )
    expect(
      (await captureSessionTokens(f.ports, { ...input, issues: [757, 758] })).capture,
    ).toBe('unavailable-or-append-uncertain')
    f.observe(1100)
    f.ports.project = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const result = await captureSessionTokens(f.ports, { ...input, issue: 759 })
    expect(result.diagnostics).toContain('token-projection-unavailable:#757')
    expect(f.receipts.map((row) => [row.issue, row.tokens])).toEqual([
      [757, 500],
      [758, 500],
      [759, 100],
    ])
    expect((await captureSessionTokens(f.ports, { ...input, issue: 759 })).capture).toBe(
      'unchanged',
    )
    expect(f.receipts).toHaveLength(3)
  })
  it('attributes non-planning work and preserves totals for mixed sessions', async () => {
    const f = await fixture()
    await captureSessionTokens(f.ports, { ...input, phase: 'implementation' })
    expect(phasedTokenReceipts(f.receipts)).toMatchObject({
      planning: 0,
      implementation: 1000,
      tokens: 1000,
    })
    const mixed = await fixture()
    await captureSessionTokens(mixed.ports, { ...input, phase: 'unknown' })
    expect(phasedTokenReceipts(mixed.receipts)).toMatchObject({
      planning: null,
      implementation: null,
      tokens: 1000,
    })
  })
  it('keeps unavailable observations and decreasing counters from changing attribution', async () => {
    const f = await fixture()
    await captureSessionTokens(f.ports, input)
    f.observe(500)
    expect((await captureSessionTokens(f.ports, input)).capture).toBe(
      'unavailable (provider-counter-reset)',
    )
    f.ports.observe = () => Promise.resolve({ unavailable: 'run-identity-unproven' })
    expect((await captureSessionTokens(f.ports, input)).capture).toContain(
      'run-identity-unproven',
    )
    expect(f.receipts).toHaveLength(1)
  })
  it('excludes old cumulative receipts before assigning a newly observed delta', async () => {
    const f = await fixture()
    const anchor = await f.ports.assign(true)
    f.receipts.push({
      schema: 2,
      issue: 757,
      receipt: anchor!.receipt,
      provider: 'codex',
      tokens: 800,
    })
    await captureSessionTokens(f.ports, { ...input, issue: 759 })
    expect(f.receipts.map((row) => row.tokens)).toEqual([800, 200])
    expect(phasedTokenReceipts(f.receipts).tokens).toBe(1000)
  })
  it('arbitrates concurrent interval creation without allocating the same range twice', async () => {
    const f = await fixture()
    const assignment = (await f.ports.assign(true))!
    const request = {
      assignment,
      root: f.root,
      issues: [757],
      phase: 'planning' as const,
      observed: 1000,
      legacyFloor: 0,
      apply: true,
    }
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => allocateSessionUsage(request)),
    )
    expect(results.some((row) => row.status === 'fulfilled')).toBe(true)
    const history = await allocateSessionUsage({
      ...request,
      issues: [758],
      observed: 1100,
    })
    expect(history.map((row) => [row.from, row.to])).toEqual([
      [0, 1000],
      [1000, 1100],
    ])
  })
})
