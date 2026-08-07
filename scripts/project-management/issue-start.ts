import { resolve } from 'node:path'

import type { WorkflowPullRequestEvidencePage } from './github-pull-requests.ts'
import type { IssueDeliveryContext } from './issue-context.ts'

export const ISSUE_START_DEPENDENCY_TIMEOUT_MS = 15 * 60 * 1_000

export interface IssueStartContextPort {
  readIssueContext: (
    issueNumber: number,
    primaryRoot: string,
  ) => Promise<IssueDeliveryContext>
  readExpectedBase: (issueNumber: number) => Promise<string | null>
}

export interface IssueStartMetadataPort {
  listWorkflowPullRequestEvidence: (
    headRefName: string,
  ) => Promise<WorkflowPullRequestEvidencePage>
}

export interface IssueWorktreeSnapshot {
  path: string
  head: string
  branch: string | null
  locked: boolean
  prunable: boolean
}

export interface IssueBranchSnapshot {
  head: string
  upstream: null | {
    name: string
    gone: boolean
  }
}

export interface IssueWorktreeState {
  trackedChanges: boolean
  untrackedPaths: boolean
  ignoredPaths: string[]
}

export type DependencyPreparationFailure =
  'aborted' | 'installer' | 'native-rebuild' | 'network' | 'npm-ci' | 'spawn' | 'timeout'

export type DependencyPreparationResult =
  { ready: true } | { ready: false; failure: DependencyPreparationFailure }

export interface IssueStartRepositoryPort {
  refreshRemoteRefs: () => Promise<void>
  canonicalPath: (path: string) => Promise<string>
  listWorktrees: () => Promise<IssueWorktreeSnapshot[]>
  inspectBranch: (branch: string) => Promise<IssueBranchSnapshot | null>
  inspectWorktreeState: (path: string) => Promise<IssueWorktreeState>
  pathExists: (path: string) => Promise<boolean>
  resolveRef: (reference: string) => Promise<string | null>
  removeWorktree: (path: string) => Promise<void>
  deleteBranch: (branch: string, expectedHead: string) => Promise<void>
  createWorktree: (branch: string, path: string, startRef: string) => Promise<void>
  prepareDependencies: (
    path: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<DependencyPreparationResult>
}

export interface IssueStartPorts {
  context: IssueStartContextPort
  metadata: IssueStartMetadataPort
  repository: IssueStartRepositoryPort
}

export interface IssueStartInput {
  issueNumber: number
  primaryRoot: string
  invocationRoot: string
  apply: boolean
  signal?: AbortSignal
}

export type IssueStartOperation =
  | { operation: 'fetch-prune'; outcome: 'completed' }
  | {
      operation: 'remove-worktree'
      outcome: 'would-remove' | 'removed'
      issueNumber: number
      worktree: string
    }
  | {
      operation: 'delete-branch'
      outcome: 'would-delete' | 'deleted'
      issueNumber: number
      branch: string
      expectedHead: string
    }
  | {
      operation: 'select-worktree'
      outcome: 'would-create' | 'created' | 'reused'
      issueNumber: number
      worktree: string
      branch: string
    }
  | {
      operation: 'prepare-dependencies'
      outcome: 'would-run' | 'ready'
      issueNumber: number
      worktree: string
    }

export interface IssueStartRetainedState {
  issueNumber: number
  branch: string
  worktree: string
  reasons: IssueStartRetentionReason[]
}

export type IssueStartRetentionReason =
  | 'active-invocation'
  | 'branch-head-mismatch'
  | 'branch-missing'
  | 'cleanup-operation-failed'
  | 'dependency-preparation-failed'
  | 'expected-base-unproven'
  | 'locked'
  | 'metadata-incomplete'
  | 'metadata-unavailable'
  | 'no-exact-merged-pr'
  | 'open-pr'
  | 'prunable'
  | 'tracked-changes'
  | 'unsafe-ignored-content'
  | 'untracked-content'
  | 'upstream-active'
  | 'upstream-unproven'
  | 'worktree-creation-failed'

export interface IssueStartBlocker {
  code: string
  message: string
}

export interface IssueStartFailure {
  operation:
    | 'cleanup-branch'
    | 'cleanup-metadata'
    | 'cleanup-worktree'
    | 'create-worktree'
    | 'prepare-dependencies'
  code: string
  message: string
}

export interface IssueStartReport {
  apply: boolean
  outcome: 'blocked' | 'failed' | 'planned' | 'ready'
  issue: {
    number: number
    parent: number | null
  }
  delivery: {
    path: 'ordinary' | 'epic-child'
    pullRequestBase: string | null
    startRef: string | null
    branch: string
    worktree: string
  }
  selectedHead: string | null
  dependency: {
    status: 'failed' | 'not-run' | 'planned' | 'ready'
    failure?: DependencyPreparationFailure
    timeoutMs: number
  }
  operations: IssueStartOperation[]
  retained: IssueStartRetainedState[]
  blockers: IssueStartBlocker[]
  failures: IssueStartFailure[]
}

interface CleanupCandidate {
  issueNumber: number
  branch: string
  worktree: string
  head: string
}

export async function runIssueStart(
  ports: IssueStartPorts,
  input: IssueStartInput,
): Promise<IssueStartReport> {
  await ports.repository.refreshRemoteRefs()
  const context = await ports.context.readIssueContext(
    input.issueNumber,
    input.primaryRoot,
  )
  const report = reportFromContext(context, input.apply)
  report.operations.push({ operation: 'fetch-prune', outcome: 'completed' })

  if (!context.ready) {
    report.blockers.push(...context.conflicts)
    report.outcome = 'blocked'
    return report
  }

  const startRef = deliveryStartRef(context)
  report.delivery.startRef = startRef
  const startHead = await ports.repository.resolveRef(startRef)
  if (startHead === null) {
    report.blockers.push({
      code: 'missing-start-ref',
      message: `The resolved start ref ${startRef} does not exist after fetch/prune.`,
    })
    report.outcome = 'blocked'
    return report
  }

  const worktrees = await ports.repository.listWorktrees()
  const selection = await selectIssueWorktree(ports.repository, context, worktrees)
  if (selection.blockers.length > 0) {
    report.blockers.push(...selection.blockers)
    report.outcome = 'blocked'
    return report
  }

  const cleanup = await planCleanup(
    ports,
    worktrees,
    input.primaryRoot,
    input.invocationRoot,
    context.delivery.branch,
  )
  report.retained.push(...cleanup.retained)
  report.failures.push(...cleanup.failures)

  if (input.apply) {
    await applyCleanup(ports.repository, cleanup.eligible, report)
  } else {
    for (const candidate of cleanup.eligible) {
      report.operations.push(
        {
          operation: 'remove-worktree',
          outcome: 'would-remove',
          issueNumber: candidate.issueNumber,
          worktree: candidate.worktree,
        },
        {
          operation: 'delete-branch',
          outcome: 'would-delete',
          issueNumber: candidate.issueNumber,
          branch: candidate.branch,
          expectedHead: candidate.head,
        },
      )
    }
  }

  if (selection.existing === null) {
    report.selectedHead = startHead
    if (input.apply) {
      try {
        await ports.repository.createWorktree(
          context.delivery.branch,
          context.delivery.worktree,
          startRef,
        )
        report.operations.push({
          operation: 'select-worktree',
          outcome: 'created',
          issueNumber: input.issueNumber,
          worktree: context.delivery.worktree,
          branch: context.delivery.branch,
        })
        report.selectedHead =
          (await ports.repository.resolveRef(context.delivery.branch)) ?? startHead
      } catch {
        report.failures.push({
          operation: 'create-worktree',
          code: 'create-worktree-failed',
          message: 'The selected issue worktree could not be created.',
        })
        report.retained.push(selectedRetention(context, 'worktree-creation-failed'))
        report.outcome = 'failed'
        return report
      }
    } else {
      report.operations.push({
        operation: 'select-worktree',
        outcome: 'would-create',
        issueNumber: input.issueNumber,
        worktree: context.delivery.worktree,
        branch: context.delivery.branch,
      })
    }
  } else {
    report.selectedHead = selection.existing.head
    report.operations.push({
      operation: 'select-worktree',
      outcome: 'reused',
      issueNumber: input.issueNumber,
      worktree: context.delivery.worktree,
      branch: context.delivery.branch,
    })
  }

  if (!input.apply) {
    report.operations.push({
      operation: 'prepare-dependencies',
      outcome: 'would-run',
      issueNumber: input.issueNumber,
      worktree: context.delivery.worktree,
    })
    report.dependency.status = 'planned'
    report.outcome = report.failures.length === 0 ? 'planned' : 'failed'
    return report
  }

  let dependency: DependencyPreparationResult
  try {
    dependency = await ports.repository.prepareDependencies(context.delivery.worktree, {
      timeoutMs: ISSUE_START_DEPENDENCY_TIMEOUT_MS,
      signal: input.signal,
    })
  } catch {
    dependency = { ready: false, failure: 'spawn' }
  }
  if (dependency.ready) {
    report.operations.push({
      operation: 'prepare-dependencies',
      outcome: 'ready',
      issueNumber: input.issueNumber,
      worktree: context.delivery.worktree,
    })
    report.dependency.status = 'ready'
  } else {
    report.dependency = {
      status: 'failed',
      failure: dependency.failure,
      timeoutMs: ISSUE_START_DEPENDENCY_TIMEOUT_MS,
    }
    report.failures.push({
      operation: 'prepare-dependencies',
      code: dependency.failure,
      message: dependencyFailureMessage(dependency.failure),
    })
    report.retained.push(selectedRetention(context, 'dependency-preparation-failed'))
  }
  report.outcome = report.failures.length === 0 ? 'ready' : 'failed'
  return report
}

async function selectIssueWorktree(
  repository: IssueStartRepositoryPort,
  context: IssueDeliveryContext,
  worktrees: IssueWorktreeSnapshot[],
): Promise<{
  existing: IssueWorktreeSnapshot | null
  blockers: IssueStartBlocker[]
}> {
  const expectedPath = await repository.canonicalPath(resolve(context.delivery.worktree))
  const canonicalPaths = new Map(
    await Promise.all(
      worktrees.map(
        async (worktree) =>
          [worktree, await repository.canonicalPath(worktree.path)] as const,
      ),
    ),
  )
  const atPath = worktrees.filter(
    (worktree) => canonicalPaths.get(worktree) === expectedPath,
  )
  const onBranch = worktrees.filter(
    (worktree) => worktree.branch === context.delivery.branch,
  )
  const blockers: IssueStartBlocker[] = []

  if (atPath.length > 1 || onBranch.length > 1) {
    blockers.push({
      code: 'ambiguous-worktree',
      message: 'The selected issue branch or worktree is registered more than once.',
    })
    return { existing: null, blockers }
  }
  const existing = atPath[0] ?? null
  if (existing !== null && existing.branch === null) {
    blockers.push({
      code: 'detached-worktree',
      message: 'The selected issue worktree is detached.',
    })
  } else if (existing !== null && existing.branch !== context.delivery.branch) {
    blockers.push({
      code: 'worktree-branch-mismatch',
      message: 'The selected issue path is registered to a different branch.',
    })
  }
  if (existing !== null && (existing.locked || existing.prunable)) {
    blockers.push({
      code: existing.locked ? 'selected-worktree-locked' : 'selected-worktree-prunable',
      message: 'The selected issue worktree is not ready for safe reuse.',
    })
  }
  const registeredBranch = onBranch[0]
  if (
    registeredBranch !== undefined &&
    canonicalPaths.get(registeredBranch) !== expectedPath
  ) {
    blockers.push({
      code: 'branch-worktree-mismatch',
      message: 'The selected issue branch is registered at a different worktree path.',
    })
  }

  const branch = await repository.inspectBranch(context.delivery.branch)
  if (existing === null) {
    if (branch !== null) {
      blockers.push({
        code: 'conflicting-branch',
        message: 'The selected issue branch already exists without its exact worktree.',
      })
    }
    if (await repository.pathExists(context.delivery.worktree)) {
      blockers.push({
        code: 'conflicting-path',
        message: 'The selected issue worktree path exists but is not registered.',
      })
    }
  } else if (branch === null || branch.head !== existing.head) {
    blockers.push({
      code: 'branch-head-mismatch',
      message: 'The selected issue branch and registered worktree HEAD do not match.',
    })
  }
  return { existing, blockers }
}

async function planCleanup(
  ports: IssueStartPorts,
  worktrees: IssueWorktreeSnapshot[],
  primaryRoot: string,
  invocationRoot: string,
  selectedBranch: string,
): Promise<{
  eligible: CleanupCandidate[]
  retained: IssueStartRetainedState[]
  failures: IssueStartFailure[]
}> {
  const eligible: CleanupCandidate[] = []
  const retained: IssueStartRetainedState[] = []
  const failures: IssueStartFailure[] = []
  const canonicalInvocationRoot = await ports.repository.canonicalPath(invocationRoot)
  for (const worktree of worktrees) {
    const owned = await workflowOwnedWorktree(worktree, primaryRoot, ports.repository)
    if (owned === null || owned.branch === selectedBranch) continue
    const reasons: IssueStartRetentionReason[] = []
    if ((await ports.repository.canonicalPath(worktree.path)) === canonicalInvocationRoot)
      reasons.push('active-invocation')
    if (worktree.locked) reasons.push('locked')
    if (worktree.prunable) reasons.push('prunable')
    if (reasons.length === 0) {
      try {
        const state = await ports.repository.inspectWorktreeState(worktree.path)
        if (state.trackedChanges) reasons.push('tracked-changes')
        if (state.untrackedPaths) reasons.push('untracked-content')
        if (state.ignoredPaths.some((path) => !isDisposableIgnoredPath(path))) {
          reasons.push('unsafe-ignored-content')
        }
      } catch {
        reasons.push('prunable')
      }
    }
    const branch = await ports.repository.inspectBranch(owned.branch)
    if (branch === null) reasons.push('branch-missing')
    else if (branch.head !== worktree.head) reasons.push('branch-head-mismatch')
    else if (branch.upstream === null) reasons.push('upstream-unproven')
    else if (!branch.upstream.gone) reasons.push('upstream-active')

    if (reasons.length === 0) {
      try {
        const expectedBase = await ports.context.readExpectedBase(owned.issueNumber)
        if (expectedBase === null) reasons.push('expected-base-unproven')
        const evidence = await ports.metadata.listWorkflowPullRequestEvidence(
          owned.branch,
        )
        if (!evidence.complete) reasons.push('metadata-incomplete')
        if (evidence.pullRequests.some((pullRequest) => pullRequest.state === 'OPEN')) {
          reasons.push('open-pr')
        }
        const exactMerged = evidence.pullRequests.some(
          (pullRequest) =>
            pullRequest.state === 'MERGED' &&
            pullRequest.headRefName === owned.branch &&
            pullRequest.headRefOid === worktree.head &&
            expectedBase !== null &&
            pullRequest.baseRefName === expectedBase,
        )
        if (!exactMerged) reasons.push('no-exact-merged-pr')
      } catch {
        reasons.push('metadata-unavailable')
        failures.push({
          operation: 'cleanup-metadata',
          code: 'cleanup-metadata-failed',
          message: `Cleanup evidence for issue #${owned.issueNumber} could not be read.`,
        })
      }
    }

    if (reasons.length > 0) {
      retained.push({ ...owned, reasons: uniqueReasons(reasons) })
    } else {
      eligible.push({ ...owned, head: worktree.head })
    }
  }
  return { eligible, retained, failures }
}

async function applyCleanup(
  repository: IssueStartRepositoryPort,
  eligible: CleanupCandidate[],
  report: IssueStartReport,
): Promise<void> {
  for (const candidate of eligible) {
    try {
      await repository.removeWorktree(candidate.worktree)
      report.operations.push({
        operation: 'remove-worktree',
        outcome: 'removed',
        issueNumber: candidate.issueNumber,
        worktree: candidate.worktree,
      })
    } catch {
      report.failures.push({
        operation: 'cleanup-worktree',
        code: 'cleanup-worktree-failed',
        message: `The eligible worktree for issue #${candidate.issueNumber} could not be removed.`,
      })
      report.retained.push({
        issueNumber: candidate.issueNumber,
        branch: candidate.branch,
        worktree: candidate.worktree,
        reasons: ['cleanup-operation-failed'],
      })
      continue
    }
    try {
      await repository.deleteBranch(candidate.branch, candidate.head)
      report.operations.push({
        operation: 'delete-branch',
        outcome: 'deleted',
        issueNumber: candidate.issueNumber,
        branch: candidate.branch,
        expectedHead: candidate.head,
      })
    } catch {
      report.failures.push({
        operation: 'cleanup-branch',
        code: 'cleanup-branch-failed',
        message: `The eligible local branch for issue #${candidate.issueNumber} could not be deleted at its expected HEAD.`,
      })
      report.retained.push({
        issueNumber: candidate.issueNumber,
        branch: candidate.branch,
        worktree: candidate.worktree,
        reasons: ['cleanup-operation-failed'],
      })
    }
  }
}

function reportFromContext(
  context: IssueDeliveryContext,
  apply: boolean,
): IssueStartReport {
  return {
    apply,
    outcome: 'planned',
    issue: { number: context.issue.number, parent: context.parent?.number ?? null },
    delivery: {
      path: context.delivery.path,
      pullRequestBase: context.delivery.base,
      startRef: null,
      branch: context.delivery.branch,
      worktree: context.delivery.worktree,
    },
    selectedHead: null,
    dependency: {
      status: 'not-run',
      timeoutMs: ISSUE_START_DEPENDENCY_TIMEOUT_MS,
    },
    operations: [],
    retained: [],
    blockers: [],
    failures: [],
  }
}

async function workflowOwnedWorktree(
  worktree: IssueWorktreeSnapshot,
  primaryRoot: string,
  repository: IssueStartRepositoryPort,
): Promise<Omit<CleanupCandidate, 'head'> | null> {
  if (worktree.branch === null) return null
  const match = /^agent\/issue-([1-9]\d*)$/.exec(worktree.branch)
  if (match === null) return null
  const issueNumber = Number(match[1])
  const expectedPath = resolve(`${primaryRoot}-worktrees`, `issue-${issueNumber}`)
  if (
    (await repository.canonicalPath(worktree.path)) !==
    (await repository.canonicalPath(expectedPath))
  ) {
    return null
  }
  return {
    issueNumber,
    branch: worktree.branch,
    worktree: worktree.path,
  }
}

function deliveryStartRef(context: IssueDeliveryContext): string {
  if (context.delivery.base === null) {
    throw new Error('A ready delivery context must have a base.')
  }
  return `origin/${context.delivery.base}`
}

export function isDisposableIgnoredPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return [
    '.electron-vite/',
    '.vite/',
    '.vitest/',
    'coverage/',
    'dist/',
    'node_modules/',
    'out/',
    'playwright-report/',
    'test-results/',
  ].some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

function selectedRetention(
  context: IssueDeliveryContext,
  reason: IssueStartRetentionReason,
): IssueStartRetainedState {
  return {
    issueNumber: context.issue.number,
    branch: context.delivery.branch,
    worktree: context.delivery.worktree,
    reasons: [reason],
  }
}

function uniqueReasons(
  reasons: IssueStartRetentionReason[],
): IssueStartRetentionReason[] {
  return [...new Set(reasons)]
}

function dependencyFailureMessage(failure: DependencyPreparationFailure): string {
  switch (failure) {
    case 'aborted':
      return 'Dependency preparation was interrupted; the selected worktree was retained.'
    case 'installer':
      return 'An npm installer step failed; the selected worktree was retained.'
    case 'native-rebuild':
      return 'The native dependency rebuild failed; the selected worktree was retained.'
    case 'network':
      return 'Dependency preparation failed because the registry or network was unavailable; the selected worktree was retained.'
    case 'npm-ci':
      return 'npm ci failed; the selected worktree was retained.'
    case 'spawn':
      return 'npm ci could not be started; the selected worktree was retained.'
    case 'timeout':
      return 'npm ci exceeded the 15-minute timeout; the selected worktree was retained.'
  }
}

export function issueStartExitCode(report: IssueStartReport): 0 | 1 | 2 {
  if (report.outcome === 'blocked') return 2
  if (report.outcome === 'failed') return 1
  return 0
}
