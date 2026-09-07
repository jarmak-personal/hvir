import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import type { PullRequestStatus } from './contributor-status.ts'

interface NativePullRequest {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefOid: string
  isDraft: boolean
  autoMergeRequest: { enabledAt: string } | null
  reviewDecision: string | null
  mergeStateStatus: string
}
interface NativeCheck {
  __typename: string
  isRequired: boolean
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
}

/** Requiredness is a native GitHub fact, not a second implementation of merge admission. */
export async function readGitHubAcceptance(
  client: GitHubClient,
  owner: string,
  name: string,
  number: number,
): Promise<PullRequestStatus> {
  const variables = { owner, name, number }
  const read = async (): Promise<NativePullRequest> => {
    const data: { repository: { pullRequest: NativePullRequest | null } | null } =
      await client.graphql(
        `query ContributorAcceptance($owner:String!,$name:String!,$number:Int!) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) {
          number state baseRefName headRefOid isDraft autoMergeRequest { enabledAt }
          reviewDecision mergeStateStatus
        } }
      }`,
        variables,
      )
    if (!data.repository?.pullRequest) throw new Error('Pull request unavailable.')
    return data.repository.pullRequest
  }
  const before = await read()
  let checks: PullRequestStatus['checks'] = []
  let checksAvailable = false
  let stale = false
  try {
    let after: string | null = null
    do {
      const data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: {
                commit: {
                  oid: string
                  statusCheckRollup: {
                    contexts: { nodes: NativeCheck[]; pageInfo: PageInfo }
                  } | null
                }
              }[]
            }
          } | null
        } | null
      } = await client.graphql(
        `query ContributorRequiredChecks(
        $owner:String!,$name:String!,$number:Int!,$after:String) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) {
          commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100,after:$after) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion isRequired(pullRequestNumber:$number) }
              ... on StatusContext { context state isRequired(pullRequestNumber:$number) }
            }
            pageInfo { endCursor hasNextPage }
          } } } } }
        } }
      }`,
        { ...variables, after },
      )
      const commit = data.repository?.pullRequest?.commits.nodes[0]?.commit
      const contexts = commit?.statusCheckRollup?.contexts
      if (!commit || !contexts) throw new Error('Required checks unavailable.')
      stale ||= commit.oid !== before.headRefOid
      for (const check of contexts.nodes) {
        if (typeof check.isRequired !== 'boolean')
          throw new Error('Requiredness unavailable.')
        if (!check.isRequired) continue
        const bucket = nativeCheckBucket(check)
        const checkName = check.name ?? check.context
        if (!bucket || !checkName || checkName.length > 200)
          throw new Error('Required check invalid.')
        checks.push({ name: checkName, bucket })
      }
      after = nextPageCursor(contexts.pageInfo)
    } while (after !== null)
    checksAvailable = checks.length > 0
  } catch {
    checks = []
  }
  const current = await read()
  if (
    current.number !== number ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(current.state) ||
    !/^[a-f0-9]{40}$/.test(current.headRefOid) ||
    typeof current.baseRefName !== 'string'
  ) {
    throw new Error('Pull request facts invalid.')
  }
  return {
    number,
    state: current.state,
    base: current.baseRefName,
    head: current.headRefOid,
    draft: current.isDraft,
    mergeRequest: current.autoMergeRequest !== null,
    review: current.reviewDecision ?? 'unknown',
    mergeability: current.mergeStateStatus,
    checks,
    checksAvailable,
    stale:
      stale ||
      before.headRefOid !== current.headRefOid ||
      before.baseRefName !== current.baseRefName,
  }
}

function nativeCheckBucket(
  check: NativeCheck,
): PullRequestStatus['checks'][number]['bucket'] | undefined {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass'
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending'
    if (check.state === 'FAILURE' || check.state === 'ERROR') return 'fail'
    return undefined
  }
  if (check.__typename !== 'CheckRun') return undefined
  if (check.status !== 'COMPLETED') return 'pending'
  if (check.conclusion === 'SUCCESS') return 'pass'
  if (check.conclusion === 'SKIPPED' || check.conclusion === 'NEUTRAL') return 'skipping'
  if (check.conclusion === 'CANCELLED') return 'cancel'
  if (
    ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(
      check.conclusion ?? '',
    )
  )
    return 'fail'
  return undefined
}
