export interface ClosedIssue {
  closedAt: string | null
  number: number
  title: string
  url: string
}

export function sortClosedIssues<T extends ClosedIssue>(issues: readonly T[]): T[]
