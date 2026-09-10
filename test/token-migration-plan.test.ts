import { describe, expect, it } from 'vitest'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  LEGACY_PROJECT_FIELDS,
} from '../scripts/project-management/canonical-project-config.ts'
import {
  planTokenMigration,
  TOKEN_DELETION_TARGETS,
  type TokenMigrationItem,
  type TokenMigrationSnapshot,
} from '../scripts/project-management/token-migration-plan.ts'
import {
  migratedTokenHistory,
  readTokenReceipts,
  type SessionTokenReceipt,
} from '../scripts/project-management/session-token-receipts.ts'
import { serializeTokenMigration } from '../scripts/project-management/contributor-token-migration.ts'
import {
  recoverLegacyTokenTotals,
  parseLegacyTokenEvidence,
} from '../scripts/project-management/legacy-token-evidence.ts'

const field = (name: string) =>
  LEGACY_PROJECT_FIELDS.find((row) => row.name === name)!.id!
function item(
  issue: number,
  totals: {
    planning?: number
    implementation?: number
    review?: number
    tokens?: number
  } = {},
): TokenMigrationItem {
  const values: Record<string, string | number | null> = {}
  for (const [name, value] of Object.entries(totals))
    values[
      field(
        (
          {
            planning: 'Planning tokens',
            implementation: 'Implementation tokens',
            review: 'Review tokens',
            tokens: 'Lifecycle tokens',
          } as Record<string, string>
        )[name]!,
      )
    ] = value
  return {
    id: `item-${issue}`,
    archived: false,
    issue,
    parent: null,
    children: [],
    epic: false,
    values,
    history: { receipts: [], legacy: false, diagnostics: [] },
  }
}
function snapshot(items: TokenMigrationItem[]): TokenMigrationSnapshot {
  return {
    schema: 1,
    project: CANONICAL_PROJECT_CONFIGURATION.id,
    fields: [
      ...LEGACY_PROJECT_FIELDS.map((row) => ({
        id: row.id!,
        name: `Legacy: ${row.name}`,
        dataType: row.dataType ?? 'SINGLE_SELECT',
      })),
      { id: 'PVTF_lAHOBkzMzc4Bdudrzhhh8xo', name: 'Recorded tokens', dataType: 'NUMBER' },
      { id: 'PVTF_lAHOBkzMzc4Bdudrzhhh8xw', name: 'Token scope', dataType: 'TEXT' },
    ],
    items,
    corrections: [],
  }
}
const receipt: SessionTokenReceipt = {
  schema: 2,
  issue: 1,
  receipt: 'a'.repeat(64),
  provider: 'codex',
  tokens: 100,
}

describe('reviewable historical token migration', () => {
  it('uses Lifecycle as the total, combines non-planning counts, and preserves archived originals', () => {
    const row = item(1, { planning: 200, implementation: 600, review: 200, tokens: 1000 })
    row.archived = true
    const plan = planTokenMigration(snapshot([row]))
    expect(plan.diagnostics).toEqual([])
    expect(plan.receipts[0]).toMatchObject({
      tokens: 1000,
      planning: 200,
      implementation: 800,
      source: { values: row.values },
    })
    expect(plan.projections[0]?.totals).toEqual({
      tokens: 1000,
      planning: 200,
      implementation: 800,
    })
    expect(plan.deletions.map((target) => target.id)).toEqual(
      TOKEN_DELETION_TARGETS.map((target) => target.id),
    )
    expect(plan.renames.map((target) => target.to)).toEqual([
      'Planning tokens',
      'Implementation tokens',
      'Total tokens',
    ])
  })
  it('retains known historical planning counts and unknown splits without fabricating zeros', () => {
    const plan = planTokenMigration(
      snapshot([item(1, { tokens: 1000 }), item(2, { tokens: 1000, planning: 200 })]),
    )
    expect(plan.receipts[0]).toMatchObject({
      tokens: 1000,
      planning: null,
      implementation: null,
    })
    expect(plan.receipts[1]).toMatchObject({
      tokens: 1000,
      planning: 200,
      implementation: null,
    })
  })
  it('blocks unresolved historical overlap and phase discrepancies until an evidence-backed correction', () => {
    const row = item(1, { tokens: 1000 })
    row.history.receipts = [receipt]
    const evidence = snapshot([
      row,
      item(2, { tokens: 100, planning: 90, implementation: 90 }),
    ])
    expect(planTokenMigration(evidence).diagnostics).toEqual([
      'historical-attribution-needs-evidence:#1',
      'historical-attribution-needs-evidence:#2',
    ])
    evidence.corrections = [
      {
        issue: 1,
        totals: { tokens: 1050, planning: null, implementation: null },
        evidence:
          'Maintainer evidence: 50 of the newer 100 tokens overlaps the historical total; retained source counters establish both ranges.',
      },
      {
        issue: 2,
        totals: { tokens: 100, planning: null, implementation: null },
        evidence:
          'Lifecycle is authoritative; conflicting phase fields are preserved for inspection.',
      },
    ]
    const plan = planTokenMigration(evidence)
    expect(plan.diagnostics).toEqual([])
    expect(plan.receipts[0]).toMatchObject({
      tokens: 1050,
      covered: [{ receipt: receipt.receipt, tokens: 100 }],
    })
    const migrated = { ...row.history, migrations: [plan.receipts[0]!] }
    expect(migratedTokenHistory(migrated).tokens).toBe(1050)
    migrated.receipts = [receipt, { ...receipt, tokens: 125 }]
    expect(migratedTokenHistory(migrated).tokens).toBe(1075)
    migrated.receipts = []
    expect(migratedTokenHistory(migrated).diagnostics).toContain(
      'migration-covered-receipt-unavailable',
    )
  })
  it('subtracts child rollups to derive epic-owned history and adds each direct contribution once', () => {
    const epic = item(1, { planning: 200, implementation: 800, tokens: 1000 })
    epic.epic = true
    epic.children = [2, 3]
    const a = item(2, { planning: 100, implementation: 300, tokens: 400 })
    a.parent = 1
    const b = item(3, { planning: 50, implementation: 150, tokens: 200 })
    b.parent = 1
    const plan = planTokenMigration(snapshot([epic, a, b]))
    expect(plan.diagnostics).toEqual([])
    expect(plan.receipts[0]).toMatchObject({
      tokens: 400,
      planning: 50,
      implementation: 350,
    })
    expect(plan.projections[0]?.totals).toEqual({
      tokens: 1000,
      planning: 200,
      implementation: 800,
    })
    expect(planTokenMigration(snapshot([epic, a])).diagnostics).toContain(
      'historical-attribution-needs-evidence:#1',
    )
  })
  it('recovers an exact epic subtotal despite unrecorded children, without inventing their counts', () => {
    const epic = item(1, { tokens: 100 })
    epic.epic = true
    epic.children = [2, 3]
    epic.history.legacyEvidence = [
      {
        key: 'a'.repeat(64),
        run: 'b'.repeat(64),
        phase: 'epic-coordination',
        tokens: 20,
      },
    ]
    const child = item(2, { tokens: 80 })
    child.parent = 1
    child.history.legacyEvidence = [
      { key: 'c'.repeat(64), run: 'd'.repeat(64), phase: 'implementation', tokens: 80 },
    ]
    const unknown = item(3)
    unknown.parent = 1
    const plan = planTokenMigration(snapshot([epic, child, unknown]))
    expect(plan.diagnostics).toEqual([])
    expect(plan.receipts.find((row) => row.issue === 1)).toMatchObject({
      tokens: 20,
      planning: 0,
      implementation: 20,
    })
    expect(plan.projections.find((row) => row.issue === 3)?.totals.tokens).toBeNull()
    expect(plan.projections.find((row) => row.issue === 1)?.totals.tokens).toBe(100)
  })
  it('does not subtract child histories from a new epic with no historical rollup', () => {
    const epic = item(1)
    epic.epic = true
    epic.children = [2]
    epic.history.receipts = [receipt]
    const child = item(2)
    child.parent = 1
    const plan = planTokenMigration(snapshot([epic, child]))
    expect(plan.diagnostics).toEqual([])
    expect(plan.projections[0]?.totals).toEqual({
      tokens: 100,
      planning: null,
      implementation: null,
    })
  })
  it('preserves migrated contributions when newer classified receipts arrive, including after a null baseline', () => {
    const row = item(1, { planning: 20, implementation: 80, tokens: 100 })
    const baseline = planTokenMigration(snapshot([row])).receipts[0]!
    row.history.migrations = [baseline]
    row.history.receipts = [
      { ...receipt, schema: 3, phase: 'implementation', tokens: 50 },
    ]
    const later = planTokenMigration(snapshot([row]))
    expect(later.projections[0]?.totals).toEqual({
      tokens: 150,
      planning: 20,
      implementation: 130,
    })
    expect(
      migratedTokenHistory({
        ...row.history,
        migrations: [{ ...baseline, tokens: null, planning: null, implementation: null }],
      }),
    ).toMatchObject({ tokens: 50, planning: 0, implementation: 50 })
    const body = serializeTokenMigration(baseline)
    const comment = { body, authorLogin: 'owner', createdAt: 'now', updatedAt: 'now' }
    expect(readTokenReceipts(1, 'owner', [comment, comment]).migrations).toHaveLength(2)
    expect(
      migratedTokenHistory(readTokenReceipts(1, 'owner', [comment, comment])).tokens,
    ).toBe(100)
    expect(
      readTokenReceipts(1, 'owner', [{ ...comment, updatedAt: 'later' }]).diagnostics,
    ).toContain('invalid-token-migration')
  })
  it('recovers retired counter evidence with exact supersession and excludes reasoning double counts', () => {
    const record = {
      schema: 1,
      issueNumber: 1,
      phase: 'issue-planning',
      runKey: 'b'.repeat(64),
      idempotencyKey: 'c'.repeat(64),
      availability: 'complete',
      usage: {
        freshInputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 3,
      },
    }
    const body = `<!-- hvir-agent-work-measurement:v1 -->\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``
    const first = parseLegacyTokenEvidence(body, 1)
    const next = { ...first, key: 'd'.repeat(64), supersedes: first.key, tokens: 50 }
    expect(recoverLegacyTokenTotals([first, first, next])).toEqual({
      tokens: 50,
      planning: 50,
      implementation: 0,
    })
    expect(first.tokens).toBe(35)
    const row = item(1)
    row.history.legacyEvidence = [first]
    expect(planTokenMigration(snapshot([row])).receipts[0]).toMatchObject({
      tokens: 35,
      planning: 35,
      implementation: 0,
    })
    expect(() => recoverLegacyTokenTotals([next])).toThrow('supersession')
  })
})
