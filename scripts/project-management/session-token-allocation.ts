/** Provider-neutral allocation of newly observed usage. */
export type TokenPhase = 'planning' | 'implementation' | 'unknown'
export interface TokenTotals {
  planning: number | null
  implementation: number | null
  tokens: number | null
}
export interface SessionAllocation {
  key: string
  from: number
  to: number
  phase: TokenPhase
  issues: number[]
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function allocationIssues(issues: readonly number[]): number[] {
  if (
    !issues.length ||
    issues.length > 100 ||
    issues.some((n) => !validTokenCount(n) || n === 0)
  )
    throw new Error('Select between one and 100 positive issue numbers.')
  if (new Set(issues).size !== issues.length)
    throw new Error('Duplicate allocation issue.')
  return [...issues].sort((a, b) => a - b)
}

export function isSessionAllocation(value: unknown): value is SessionAllocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as SessionAllocation
  try {
    return (
      Object.keys(row).sort().join(',') === 'from,issues,key,phase,to' &&
      /^[a-f0-9]{64}$/.test(row.key) &&
      validTokenCount(row.from) &&
      validTokenCount(row.to) &&
      row.to >= row.from &&
      ['planning', 'implementation', 'unknown'].includes(row.phase) &&
      Array.isArray(row.issues) &&
      JSON.stringify(allocationIssues(row.issues)) === JSON.stringify(row.issues) &&
      (row.phase === 'planning' || row.issues.length === 1)
    )
  } catch {
    return false
  }
}

/** Remainders go to ascending issue numbers, independent of caller order. */
export function allocationShares(
  allocation: SessionAllocation,
): { issue: number; tokens: number }[] {
  if (!isSessionAllocation(allocation)) throw new Error('Invalid session allocation.')
  const delta = allocation.to - allocation.from
  const quotient = Math.floor(delta / allocation.issues.length)
  const remainder = delta % allocation.issues.length
  return allocation.issues.map((issue, index) => ({
    issue,
    tokens: quotient + (index < remainder ? 1 : 0),
  }))
}

/** Aggregate recorded contributions; absence remains unknown and unsafe sums fail. */
export function sumTokenTotals(contributions: readonly TokenTotals[]): TokenTotals {
  const known = contributions.filter((row) => row.tokens !== null)
  const sum = (key: keyof TokenTotals) => {
    if (!known.length || known.some((row) => row[key] === null)) return null
    const value = known.reduce((sum, row) => sum + row[key]!, 0)
    if (!validTokenCount(value)) throw new Error('Token aggregate overflow.')
    return value
  }
  return {
    tokens: sum('tokens'),
    planning: sum('planning'),
    implementation: sum('implementation'),
  }
}
