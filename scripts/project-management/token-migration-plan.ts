import { recoverLegacyTokenTotals } from './legacy-token-evidence.ts'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  LEGACY_PROJECT_FIELDS,
} from './canonical-project-config.ts'
import {
  validTokenTotals,
  type TokenMigrationReceipt,
} from './contributor-token-migration.ts'
import {
  phasedTokenReceipts,
  migratedTokenHistory,
  type TokenReceiptHistory,
} from './session-token-receipts.ts'
import { sumTokenTotals, type TokenTotals } from './session-token-allocation.ts'

export const TOKEN_FIELD_TARGETS = [
  { id: 'PVTF_lAHOBkzMzc4BdudrzhfitOk', name: 'Planning tokens', key: 'planning' },
  {
    id: 'PVTF_lAHOBkzMzc4BdudrzhfitOo',
    name: 'Implementation tokens',
    key: 'implementation',
  },
  { id: 'PVTF_lAHOBkzMzc4Bdudrzhhh8xo', name: 'Total tokens', key: 'tokens' },
] as const
export const TOKEN_DELETION_TARGETS = [
  ...LEGACY_PROJECT_FIELDS.filter(
    (field) => !TOKEN_FIELD_TARGETS.some((target) => target.id === field.id),
  ),
  { id: 'PVTF_lAHOBkzMzc4Bdudrzhhh8xw', name: 'Token scope' },
]
export interface TokenMigrationItem {
  id: string
  archived: boolean
  issue: number | null
  parent: number | null
  children: number[]
  epic: boolean
  values: Record<string, string | number | null>
  history: TokenReceiptHistory
}
export interface TokenMigrationSnapshot {
  schema: 1
  project: string
  fields: { id: string; name: string; dataType: string }[]
  items: TokenMigrationItem[]
  corrections: { issue: number; totals: TokenTotals; evidence: string }[]
}
export interface TokenMigrationPlan {
  receipts: TokenMigrationReceipt[]
  projections: { item: string; issue: number; totals: TokenTotals }[]
  renames: { id: string; from: string; to: string }[]
  deletions: { id: string; name: string }[]
  diagnostics: string[]
}

/** Historical Lifecycle is an aggregate, never another component to add. */
function historical(
  item: TokenMigrationItem,
  recovered = recoverLegacyTokenTotals(item.history.legacyEvidence ?? []),
): TokenTotals {
  const value = (name: string) => {
    const id = LEGACY_PROJECT_FIELDS.find((field) => field.name === name)!.id!
    const raw = item.values[id]
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
      throw new Error('Invalid historical token count.')
    return raw
  }
  const tokens = value('Lifecycle tokens')
  const planning = value('Planning tokens')
  const implementation = value('Implementation tokens')
  const review = value('Review tokens')
  const nonPlanning =
    implementation === null && review === null
      ? null
      : (implementation ?? 0) + (review ?? 0)
  // A complete pair must reconcile exactly. Otherwise preserve only the authoritative total.
  if (tokens !== null) {
    if (recovered.tokens === tokens) return recovered
    if (planning !== null && nonPlanning !== null && planning + nonPlanning === tokens)
      return { tokens, planning, implementation: nonPlanning }
    if (planning !== null && nonPlanning !== null)
      throw new Error('Historical phase discrepancy.')
    if ((planning ?? 0) > tokens || (nonPlanning ?? 0) > tokens)
      throw new Error('Historical phase discrepancy.')
    return { tokens, planning, implementation: nonPlanning }
  }
  // Missing lifecycle totals can be recovered from available components as a labeled subtotal.
  if (planning !== null && nonPlanning !== null)
    return { tokens: planning + nonPlanning, planning, implementation: nonPlanning }
  if (planning === null && nonPlanning === null) return recovered
  return { tokens: planning ?? nonPlanning, planning, implementation: nonPlanning }
}

export function planTokenMigration(snapshot: TokenMigrationSnapshot): TokenMigrationPlan {
  const plan: TokenMigrationPlan = {
    receipts: [],
    projections: [],
    renames: [],
    deletions: [],
    diagnostics: [],
  }
  if (snapshot.schema !== 1 || snapshot.project !== CANONICAL_PROJECT_CONFIGURATION.id)
    throw new Error('Wrong migration Project.')
  const seen = new Set<number>()
  const byIssue = new Map(
    snapshot.items.filter((row) => row.issue !== null).map((row) => [row.issue!, row]),
  )
  for (const target of TOKEN_FIELD_TARGETS) {
    const field = snapshot.fields.find((row) => row.id === target.id)
    const allowed = [
      target.name,
      `Legacy: ${target.name}`,
      ...(target.key === 'tokens' ? ['Recorded tokens'] : []),
    ]
    if (
      !field ||
      field.dataType !== 'NUMBER' ||
      !allowed.includes(field.name) ||
      snapshot.fields.some((row) => row.id !== target.id && row.name === target.name)
    )
      plan.diagnostics.push(`token-field-conflict:${target.name}`)
    else if (field.name !== target.name)
      plan.renames.push({ id: field.id, from: field.name, to: target.name })
  }
  for (const target of TOKEN_DELETION_TARGETS) {
    const field = snapshot.fields.find((row) => row.id === target.id)
    if (!field) continue
    if (field.name !== target.name && field.name !== `Legacy: ${target.name}`)
      plan.diagnostics.push(`deletion-field-conflict:${target.id}`)
    else plan.deletions.push({ id: field.id, name: field.name })
  }
  if (
    new Set(snapshot.corrections.map((row) => row.issue)).size !==
      snapshot.corrections.length ||
    snapshot.corrections.some(
      (row) =>
        !byIssue.has(row.issue) || !validTokenTotals(row.totals) || !row.evidence.trim(),
    )
  )
    plan.diagnostics.push('invalid-manual-corrections')
  for (const item of snapshot.items) {
    if (item.issue === null) {
      if (Object.values(item.values).some((value) => value !== null))
        plan.diagnostics.push(`unattributed-item:${item.id}`)
      continue
    }
    if (seen.has(item.issue)) {
      plan.diagnostics.push(`duplicate-project-issue:#${item.issue}`)
      continue
    }
    seen.add(item.issue)
    if (item.history.diagnostics.length) {
      plan.diagnostics.push(`incomplete-token-evidence:#${item.issue}`)
      continue
    }
    const existing = [
      ...new Map(
        (item.history.migrations ?? []).map((row) => [JSON.stringify(row), row]),
      ).values(),
    ]
    if (existing.length > 1) {
      plan.diagnostics.push(`conflicting-migration:#${item.issue}`)
      continue
    }
    if (existing[0]) {
      plan.receipts.push(existing[0])
      continue
    }
    const correction = snapshot.corrections.find((row) => row.issue === item.issue)
    if (
      !item.history.receipts.length &&
      !item.history.legacyEvidence?.length &&
      !Object.values(item.values).some((value) => value !== null)
    )
      continue
    let own: TokenTotals
    let recoveredRollupMatches = false
    let ambiguous = !!item.history.legacyDiagnostics?.length
    const hasRollup = [
      'Lifecycle tokens',
      'Planning tokens',
      'Implementation tokens',
      'Review tokens',
    ].some((name) => {
      const id = LEGACY_PROJECT_FIELDS.find((field) => field.name === name)!.id!
      return item.values[id] !== undefined && item.values[id] !== null
    })
    try {
      const recovered =
        item.epic && hasRollup
          ? sumTokenTotals(
              [
                item,
                ...item.children
                  .map((number) => byIssue.get(number))
                  .filter((row): row is TokenMigrationItem => !!row),
              ].map((row) => recoverLegacyTokenTotals(row.history.legacyEvidence ?? [])),
            )
          : undefined
      own = historical(item, recovered)
      recoveredRollupMatches =
        !!recovered && recovered.tokens !== null && recovered.tokens === own.tokens
    } catch {
      own = { tokens: null, planning: null, implementation: null }
      ambiguous = true
    }
    if (item.epic && hasRollup) {
      if (item.parent) ambiguous = true
      for (const number of item.children) {
        const child = byIssue.get(number)
        if (
          !child ||
          child.parent !== item.issue ||
          child.epic ||
          child.children.length
        ) {
          ambiguous = true
          continue
        }
        let contribution: TokenTotals
        try {
          contribution = historical(child)
        } catch {
          ambiguous = true
          continue
        }
        if (contribution.tokens === null && recoveredRollupMatches) continue
        if (
          own.tokens === null ||
          contribution.tokens === null ||
          contribution.tokens > own.tokens
        )
          ambiguous = true
        else own.tokens -= contribution.tokens
        for (const key of ['planning', 'implementation'] as const) {
          if (
            own[key] === null ||
            contribution[key] === null ||
            own[key] < contribution[key]
          )
            own[key] = null
          else own[key] -= contribution[key]
        }
      }
    }
    const recent = phasedTokenReceipts(item.history.receipts)
    if (recent.diagnostics.length) ambiguous = true
    const recorded = item.values[TOKEN_FIELD_TARGETS[2].id]
    if (!item.epic && typeof recorded === 'number' && recorded > (recent.tokens ?? 0))
      ambiguous = true
    if ((own.tokens ?? 0) > 0 && (recent.tokens ?? 0) > 0) ambiguous = true
    if (ambiguous && !correction) {
      plan.diagnostics.push(`historical-attribution-needs-evidence:#${item.issue}`)
      continue
    }
    if (correction) own = correction.totals
    else if (own.tokens === null || (own.tokens === 0 && recent.tokens !== null))
      own = recent
    const maxima = new Map<string, number>()
    for (const row of item.history.receipts)
      maxima.set(row.receipt, Math.max(maxima.get(row.receipt) ?? 0, row.tokens))
    plan.receipts.push({
      schema: 1,
      issue: item.issue,
      tokens: own.tokens,
      planning: own.planning,
      implementation: own.implementation,
      source: { item: item.id, values: item.values },
      covered: [...maxima]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([receipt, tokens]) => ({ receipt, tokens })),
      evidence:
        correction?.evidence ??
        'Canonical historical field snapshot; Lifecycle tokens is authoritative. Epic child historical rollups subtracted once. Missing splits remain unknown.',
    })
  }
  for (const item of snapshot.items) {
    if (item.issue === null) continue
    const ids = [item.issue, ...(item.epic ? item.children : [])]
    const rows = ids.map((number) => plan.receipts.find((row) => row.issue === number))
    if (rows.some((row, index) => !row && !byIssue.has(ids[index]!))) {
      plan.diagnostics.push(`missing-epic-participant:#${item.issue}`)
      continue
    }
    const contributions = rows.map((row, index) =>
      migratedTokenHistory({
        ...byIssue.get(ids[index]!)!.history,
        ...(row ? { migrations: [row] } : {}),
      }),
    )
    if (contributions.some((row) => row.diagnostics.length)) {
      plan.diagnostics.push(`migration-receipt-conflict:#${item.issue}`)
      continue
    }
    let totals: TokenTotals
    try {
      totals = sumTokenTotals(contributions)
    } catch {
      plan.diagnostics.push(`token-overflow:#${item.issue}`)
      continue
    }
    if (!validTokenTotals(totals)) plan.diagnostics.push(`token-overflow:#${item.issue}`)
    else plan.projections.push({ item: item.id, issue: item.issue, totals })
  }
  return plan
}
