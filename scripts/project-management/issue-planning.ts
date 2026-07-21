export interface IssueSnapshot {
  id: string
  number: number
  state: 'OPEN' | 'CLOSED'
  updatedAt: string
  labels: string[]
}

export interface IssueReference {
  repository: string
  number: number
  state: 'OPEN' | 'CLOSED'
}

export interface PullRequestReference {
  repository: string
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergedAt: string | null
  relationship: 'closing' | 'linked'
}

export interface PlanningIssueSnapshot extends IssueSnapshot {
  repository: string
  parent: IssueReference | null
  subIssues: IssueReference[]
  linkedPullRequests: PullRequestReference[]
}
