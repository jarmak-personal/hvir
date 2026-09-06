/** Canonical issue membership and named fields shared by Project adapters. */
export interface CanonicalProjectItem {
  id: string
  archived: boolean
  repository: string
  issueNumber: number
  kind: string | null
  status: string | null
}
