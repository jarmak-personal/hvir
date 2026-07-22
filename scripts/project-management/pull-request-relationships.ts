import type { IssueReference } from './issue-planning.ts'

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface PullRequestSnapshot {
  repository: string
  number: number
  state: PullRequestState
  isDraft: boolean
  baseRefName: string
  headRefName: string
  body: string
  closingIssues: IssueReference[]
}

export interface PullRequestBodySnapshot {
  repository: string
  number: number
  baseRefName: string
  headRefName: string
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

export interface CompletingChildTrailerError {
  code: 'malformed-completing-child' | 'multiple-completing-children' | 'self-reference'
  line: number
  issueNumber?: number
}

export interface CompletingChildTrailerParseResult {
  issueNumber?: number
  errors: CompletingChildTrailerError[]
}

const CONTRIBUTION_PREFIX = /^ {0,3}contributes-to:/i
const CONTRIBUTION_TRAILER = /^ {0,3}Contributes-to: #([1-9]\d*)[ \t]*$/
const COMPLETING_CHILD_PREFIX = /^ {0,3}completes-child:/i
const COMPLETING_CHILD_TRAILER = /^ {0,3}Completes-child: #([1-9]\d*)[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

export function parseContributionTrailers(
  body: string,
  pullRequestNumber: number,
): ContributionTrailerParseResult {
  const issueNumbers = new Set<number>()
  const warnings: ContributionTrailerWarning[] = []
  const errors: ContributionTrailerError[] = []
  for (const { line, lineNumber } of pullRequestMetadataLines(body)) {
    const match = CONTRIBUTION_TRAILER.exec(line)
    if (match === null) {
      if (CONTRIBUTION_PREFIX.test(line)) {
        errors.push({ code: 'malformed-trailer', line: lineNumber })
      }
      continue
    }

    const issueNumber = Number(match[1])
    if (!Number.isSafeInteger(issueNumber)) {
      errors.push({ code: 'malformed-trailer', line: lineNumber })
      continue
    }
    if (issueNumber === pullRequestNumber) {
      errors.push({ code: 'self-reference', line: lineNumber, issueNumber })
      continue
    }
    if (issueNumbers.has(issueNumber)) {
      warnings.push({ code: 'duplicate-trailer', line: lineNumber, issueNumber })
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

export function parseCompletingChildTrailer(
  body: string,
  pullRequestNumber: number,
): CompletingChildTrailerParseResult {
  let issueNumber: number | undefined
  const errors: CompletingChildTrailerError[] = []

  for (const { line, lineNumber } of pullRequestMetadataLines(body)) {
    const match = COMPLETING_CHILD_TRAILER.exec(line)
    if (match === null) {
      if (COMPLETING_CHILD_PREFIX.test(line)) {
        errors.push({ code: 'malformed-completing-child', line: lineNumber })
      }
      continue
    }

    const parsed = Number(match[1])
    if (!Number.isSafeInteger(parsed)) {
      errors.push({ code: 'malformed-completing-child', line: lineNumber })
      continue
    }
    if (parsed === pullRequestNumber) {
      errors.push({ code: 'self-reference', line: lineNumber, issueNumber: parsed })
      continue
    }
    if (issueNumber !== undefined) {
      errors.push({
        code: 'multiple-completing-children',
        line: lineNumber,
        issueNumber: parsed,
      })
      continue
    }
    issueNumber = parsed
  }

  return {
    ...(issueNumber === undefined || errors.length > 0 ? {} : { issueNumber }),
    errors,
  }
}

function pullRequestMetadataLines(
  body: string,
): Array<{ line: string; lineNumber: number }> {
  const lines: Array<{ line: string; lineNumber: number }> = []
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
    lines.push({ line, lineNumber: index + 1 })
  }

  return lines
}
