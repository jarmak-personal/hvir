export interface ClosedIssue {
  closedAt: string | null
  number: number
}

export function sortClosedIssues<T extends ClosedIssue>(issues: readonly T[]): T[]
