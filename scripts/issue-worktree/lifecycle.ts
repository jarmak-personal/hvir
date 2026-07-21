import type {
  GitWorktreeRepository,
  OwnedWorktreeRecord,
  RegisteredWorktree,
} from './git-worktree-repository.ts'
import type { PullRequestLookup, PullRequestMetadata } from './github-pull-requests.ts'
import {
  assertExactBaseRef,
  baseBranchName,
  expectedBranchName,
  expectedBranchRef,
  expectedMarkerRef,
  WORKFLOW_VERSION,
} from './worktree-policy.ts'

export interface IssueWorktreeLifecycleInput {
  issueNumber: number
  baseRef: string
  apply: boolean
}

export interface ReconciliationResult {
  issueNumber: number
  branchRef: string
  path: string
  status: 'retained' | 'would-remove' | 'removed'
  reasons: string[]
  pullRequestNumber?: number
}

export interface SelectionResult {
  issueNumber: number
  branchRef: string
  path: string
  baseRef: string
  baseOid: string
  status: 'would-create' | 'created' | 'reused'
}

export interface IssueWorktreeLifecycleReport {
  mode: 'dry-run' | 'apply'
  repositoryRoot: string
  fetchedAndPruned: 'origin'
  reconciliation: ReconciliationResult[]
  selection: SelectionResult
}

export async function runIssueWorktreeLifecycle(
  repository: GitWorktreeRepository,
  pullRequests: PullRequestLookup,
  input: IssueWorktreeLifecycleInput,
): Promise<IssueWorktreeLifecycleReport> {
  await repository.fetchAndPrune()
  const reconciliation: ReconciliationResult[] = []
  for (const record of await repository.listOwnedRecords()) {
    reconciliation.push(
      await reconcileOwnedWorktree(repository, pullRequests, record, input.apply),
    )
  }

  const baseOid = await repository.resolveBase(input.baseRef)
  const selection = await selectIssueWorktree(repository, input, baseOid)
  return {
    mode: input.apply ? 'apply' : 'dry-run',
    repositoryRoot: repository.primaryRoot,
    fetchedAndPruned: 'origin',
    reconciliation,
    selection,
  }
}

async function reconcileOwnedWorktree(
  repository: GitWorktreeRepository,
  pullRequests: PullRequestLookup,
  record: OwnedWorktreeRecord,
  apply: boolean,
): Promise<ReconciliationResult> {
  const branchRef = expectedBranchRef(record.issueNumber)
  const worktreePath = repository.expectedPath(record.issueNumber)
  const reasons = validateMetadata(repository, record)
  const branchOid = await repository.branchOid(branchRef)
  if (branchOid === undefined) reasons.push('the recorded local branch is missing')

  const worktrees = await repository.listWorktrees()
  const selected = exactWorktree(worktrees, worktreePath, branchRef)
  if (selected === undefined) {
    const pathOwner = worktrees.find((worktree) => worktree.path === worktreePath)
    const branchOwner = worktrees.find((worktree) => worktree.branchRef === branchRef)
    if (pathOwner !== undefined) {
      reasons.push(
        pathOwner.detached
          ? 'the deterministic path is registered as a detached worktree'
          : 'the deterministic path is registered to a different branch',
      )
    } else if (branchOwner !== undefined) {
      reasons.push('the recorded branch is registered at a different path')
    } else {
      reasons.push('the recorded worktree is not registered')
    }
  } else {
    inspectRegisteredWorktree(repository, selected, branchOid, reasons)
    if (selected.path === repository.currentRoot) {
      reasons.push('the worktree is active in the current invocation')
    }
    const status = await repository.status(selected.path)
    if (status.trackedOrUntrackedPaths.length > 0) {
      reasons.push(
        `tracked or untracked state exists at ${status.trackedOrUntrackedPaths[0]}`,
      )
    }
    if (status.unsafeIgnoredPaths.length > 0) {
      reasons.push(
        `non-disposable ignored state exists at ${status.unsafeIgnoredPaths[0]}`,
      )
    }
  }

  if (!(await repository.pathExists(worktreePath))) {
    reasons.push('the recorded worktree path is missing')
  }

  const upstream = await repository.upstreamState(record.issueNumber)
  if (!upstream.configuredForOrigin) {
    reasons.push('the branch lacks the expected origin upstream')
  } else if (upstream.remoteRefExists) {
    reasons.push(`the pruned upstream ref ${upstream.remoteRef} still exists`)
  }

  let pullRequest: PullRequestMetadata | undefined
  if (reasons.length === 0 && branchOid !== undefined && record.baseRef !== undefined) {
    try {
      const candidates = await pullRequests.listByHead(
        expectedBranchName(record.issueNumber),
      )
      const open = candidates.filter((candidate) => candidate.state === 'OPEN')
      const exactMerged = candidates.filter(
        (candidate) =>
          candidate.state === 'MERGED' &&
          candidate.mergedAt !== undefined &&
          candidate.headRefOid === branchOid &&
          candidate.headRefName === expectedBranchName(record.issueNumber) &&
          candidate.baseRefName === baseBranchName(record.baseRef ?? ''),
      )
      if (open.length > 0) reasons.push('an associated pull request is still open')
      if (exactMerged.length === 0) {
        reasons.push('no merged pull request records the exact local head and base')
      } else if (exactMerged.length > 1) {
        reasons.push('multiple merged pull requests record the exact local head and base')
      } else {
        pullRequest = exactMerged[0]
      }
    } catch (error) {
      reasons.push(`pull-request evidence is unavailable: ${errorMessage(error)}`)
    }
  }

  if (reasons.length > 0 || branchOid === undefined || pullRequest === undefined) {
    return {
      issueNumber: record.issueNumber,
      branchRef,
      path: worktreePath,
      status: 'retained',
      reasons,
    }
  }
  if (!apply) {
    return {
      issueNumber: record.issueNumber,
      branchRef,
      path: worktreePath,
      status: 'would-remove',
      reasons: [],
      pullRequestNumber: pullRequest.number,
    }
  }

  try {
    await repository.remove(record, branchOid)
    return {
      issueNumber: record.issueNumber,
      branchRef,
      path: worktreePath,
      status: 'removed',
      reasons: [],
      pullRequestNumber: pullRequest.number,
    }
  } catch (error) {
    return {
      issueNumber: record.issueNumber,
      branchRef,
      path: worktreePath,
      status: 'retained',
      reasons: [`cleanup failed: ${errorMessage(error)}`],
      pullRequestNumber: pullRequest.number,
    }
  }
}

async function selectIssueWorktree(
  repository: GitWorktreeRepository,
  input: IssueWorktreeLifecycleInput,
  resolvedBaseOid: string,
): Promise<SelectionResult> {
  const branchRef = expectedBranchRef(input.issueNumber)
  const worktreePath = repository.expectedPath(input.issueNumber)
  const records = await repository.listOwnedRecords()
  const existing = records.find((record) => record.issueNumber === input.issueNumber)
  if (existing !== undefined) {
    const errors = validateMetadata(repository, existing)
    if (existing.baseRef !== input.baseRef) {
      errors.push(
        `the worktree was created from ${existing.baseRef ?? 'missing base metadata'}, not ${input.baseRef}`,
      )
    }
    const worktrees = await repository.listWorktrees()
    const selected = exactWorktree(worktrees, worktreePath, branchRef)
    const branchOid = await repository.branchOid(branchRef)
    if (selected === undefined)
      errors.push('the issue worktree is not registered exactly')
    if (branchOid === undefined) errors.push('the issue branch is missing')
    if (selected !== undefined) {
      inspectRegisteredWorktree(repository, selected, branchOid, errors)
    }
    if (!(await repository.pathExists(worktreePath))) {
      errors.push('the issue worktree path is missing')
    }
    if (errors.length > 0) {
      throw new Error(`Cannot reuse issue #${input.issueNumber}: ${errors.join('; ')}.`)
    }
    return {
      issueNumber: input.issueNumber,
      branchRef,
      path: worktreePath,
      baseRef: existing.baseRef ?? input.baseRef,
      baseOid: existing.baseOid ?? resolvedBaseOid,
      status: 'reused',
    }
  }

  const collisions: string[] = []
  if (await repository.hasOrphanedConfig(input.issueNumber)) {
    collisions.push('workflow metadata exists without its ownership marker')
  }
  if ((await repository.branchOid(branchRef)) !== undefined) {
    collisions.push(`branch ${branchRef} already exists without workflow ownership`)
  }
  const worktrees = await repository.listWorktrees()
  if (worktrees.some((worktree) => worktree.path === worktreePath)) {
    collisions.push('the deterministic path is already a registered worktree')
  } else if (await repository.pathExists(worktreePath)) {
    collisions.push('the deterministic path already exists on disk')
  }
  if (collisions.length > 0) {
    throw new Error(
      `Cannot create issue #${input.issueNumber}: ${collisions.join('; ')}.`,
    )
  }

  if (!input.apply) {
    return {
      issueNumber: input.issueNumber,
      branchRef,
      path: worktreePath,
      baseRef: input.baseRef,
      baseOid: resolvedBaseOid,
      status: 'would-create',
    }
  }
  const created = await repository.create(
    input.issueNumber,
    input.baseRef,
    resolvedBaseOid,
  )
  return { ...created, status: 'created' }
}

function validateMetadata(
  repository: GitWorktreeRepository,
  record: OwnedWorktreeRecord,
): string[] {
  const reasons: string[] = []
  if (record.markerRef !== expectedMarkerRef(record.issueNumber)) {
    reasons.push('the ownership marker ref is not canonical')
  }
  if (record.version !== WORKFLOW_VERSION)
    reasons.push('the workflow metadata version is invalid')
  if (record.branchRef !== expectedBranchRef(record.issueNumber)) {
    reasons.push('the recorded branch is outside the workflow namespace')
  }
  if (record.path !== repository.expectedPath(record.issueNumber)) {
    reasons.push('the recorded path is not the deterministic issue path')
  }
  if (record.baseRef === undefined) {
    reasons.push('the recorded base ref is missing')
  } else {
    try {
      assertExactBaseRef(record.baseRef)
    } catch {
      reasons.push('the recorded base ref is not exact')
    }
  }
  if (record.baseOid === undefined || record.baseOid !== record.markerOid) {
    reasons.push('the ownership marker does not match the recorded base commit')
  }
  return reasons
}

function exactWorktree(
  worktrees: readonly RegisteredWorktree[],
  worktreePath: string,
  branchRef: string,
): RegisteredWorktree | undefined {
  return worktrees.find(
    (worktree) => worktree.path === worktreePath && worktree.branchRef === branchRef,
  )
}

function inspectRegisteredWorktree(
  repository: GitWorktreeRepository,
  worktree: RegisteredWorktree,
  branchOid: string | undefined,
  reasons: string[],
): void {
  if (worktree.detached || worktree.branchRef === undefined) {
    reasons.push('the worktree is detached')
  }
  if (worktree.lockedReason !== undefined) {
    reasons.push(
      `the worktree is locked: ${worktree.lockedReason || 'no reason provided'}`,
    )
  }
  if (worktree.prunableReason !== undefined) {
    reasons.push(`Git marks the worktree prunable: ${worktree.prunableReason}`)
  }
  if (branchOid !== undefined && worktree.headOid !== branchOid) {
    reasons.push('the worktree HEAD does not match its local branch')
  }
  if (worktree.path === repository.primaryRoot) {
    reasons.push('the workflow record points at the primary checkout')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
