import type { IssueReference } from './issue-planning.ts'

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface PullRequestSnapshot {
  repository: string
  number: number
  state: PullRequestState
  isDraft: boolean
  mergedAt: string | null
  body: string
  closingIssues: IssueReference[]
}

export interface PullRequestBodySnapshot {
  repository: string
  number: number
  body: string
}

export interface ContributionTrailerWarning {
  code: 'duplicate-trailer'
  line: number
  issueNumber: number
}

export interface ContributionTrailerError {
  code: 'malformed-trailer' | 'self-reference'
  line: number
  issueNumber?: number
}

export interface ContributionTrailerParseResult {
  issueNumbers: number[]
  warnings: ContributionTrailerWarning[]
  errors: ContributionTrailerError[]
}

const CONTRIBUTION_PREFIX = /^ {0,3}contributes-to:/i
const CONTRIBUTION_TRAILER = /^ {0,3}Contributes-to: #([1-9]\d*)[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

export function parseContributionTrailers(
  body: string,
  pullRequestNumber: number,
): ContributionTrailerParseResult {
  const issueNumbers = new Set<number>()
  const warnings: ContributionTrailerWarning[] = []
  const errors: ContributionTrailerError[] = []
  let comment = false
  let fence: { marker: '`' | '~'; length: number } | undefined

  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (fence !== undefined) {
      const fenceMatch = FENCE.exec(line)
      if (fenceMatch !== null) {
        const sequence = fenceMatch[1]!
        if (sequence[0] === fence.marker && sequence.length >= fence.length) {
          fence = undefined
        }
      }
      continue
    }
    if (comment) {
      if (line.includes('-->')) comment = false
      continue
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->', line.indexOf('<!--') + 4)) comment = true
      continue
    }

    const fenceMatch = FENCE.exec(line)
    if (fenceMatch !== null) {
      const sequence = fenceMatch[1]!
      fence = { marker: sequence[0] as '`' | '~', length: sequence.length }
      continue
    }

    const match = CONTRIBUTION_TRAILER.exec(line)
    if (match === null) {
      if (CONTRIBUTION_PREFIX.test(line)) {
        errors.push({ code: 'malformed-trailer', line: index + 1 })
      }
      continue
    }

    const issueNumber = Number(match[1])
    if (!Number.isSafeInteger(issueNumber)) {
      errors.push({ code: 'malformed-trailer', line: index + 1 })
      continue
    }
    if (issueNumber === pullRequestNumber) {
      errors.push({ code: 'self-reference', line: index + 1, issueNumber })
      continue
    }
    if (issueNumbers.has(issueNumber)) {
      warnings.push({ code: 'duplicate-trailer', line: index + 1, issueNumber })
      continue
    }
    issueNumbers.add(issueNumber)
  }

  return {
    issueNumbers: [...issueNumbers].sort((first, second) => first - second),
    warnings,
    errors,
  }
}
