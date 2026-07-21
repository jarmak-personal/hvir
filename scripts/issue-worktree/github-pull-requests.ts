import type { SystemRunner } from './system-runner.ts'

export interface PullRequestMetadata {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergedAt?: string
  headRefName: string
  headRefOid: string
  baseRefName: string
}

export interface PullRequestLookup {
  listByHead(headRefName: string): Promise<PullRequestMetadata[]>
}

export class GhPullRequestLookup implements PullRequestLookup {
  private readonly runner: SystemRunner
  private readonly cwd: string

  constructor(runner: SystemRunner, cwd: string) {
    this.runner = runner
    this.cwd = cwd
  }

  async listByHead(headRefName: string): Promise<PullRequestMetadata[]> {
    const result = await this.runner.run(
      'gh',
      [
        'pr',
        'list',
        '--head',
        headRefName,
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        'number,state,mergedAt,headRefName,headRefOid,baseRefName',
      ],
      { cwd: this.cwd },
    )
    return parsePullRequests(result.stdout)
  }
}

function parsePullRequests(output: string): PullRequestMetadata[] {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error('GitHub CLI returned malformed pull-request JSON.')
  }
  if (!Array.isArray(value)) {
    throw new Error('GitHub CLI returned a non-array pull-request response.')
  }
  return value.map((candidate) => parsePullRequest(candidate))
}

function parsePullRequest(candidate: unknown): PullRequestMetadata {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('GitHub CLI returned a malformed pull-request record.')
  }
  const record = candidate as Record<string, unknown>
  const number = positiveInteger(record.number, 'number')
  const state = pullRequestState(record.state)
  const mergedAt = optionalString(record.mergedAt, 'mergedAt')
  return {
    number,
    state,
    ...(mergedAt === undefined ? {} : { mergedAt }),
    headRefName: requiredString(record.headRefName, 'headRefName'),
    headRefOid: requiredString(record.headRefOid, 'headRefOid'),
    baseRefName: requiredString(record.baseRefName, 'baseRefName'),
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`GitHub CLI pull-request ${field} is invalid.`)
  }
  return value as number
}

function pullRequestState(value: unknown): PullRequestMetadata['state'] {
  if (value === 'OPEN' || value === 'CLOSED' || value === 'MERGED') return value
  throw new Error('GitHub CLI pull-request state is invalid.')
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`GitHub CLI pull-request ${field} is invalid.`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined
  return requiredString(value, field)
}
