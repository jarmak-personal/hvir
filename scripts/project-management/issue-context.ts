import { join } from 'node:path'

import { resolveIssueDelivery, type IssueDeliveryPort } from './issue-delivery.ts'
import type { PlanningRecordReport } from './planning-record.ts'
import {
  parseCompletingChildTrailer,
  parseContributionTrailers,
  type PullRequestBodySnapshot,
} from './pull-request-relationships.ts'

export interface IssueContextPort extends IssueDeliveryPort {
  listOpenPullRequestBodies: () => Promise<PullRequestBodySnapshot[]>
}

export interface IssueContextInput {
  issueNumber: number
  primaryRoot: string
}

export interface IssueContextConflict {
  code:
    | 'issue-closed'
    | 'invalid-kind'
    | 'project-membership'
    | 'project-kind'
    | 'project-status'
    | 'cross-repository-parent'
    | 'parent-closed'
    | 'parent-not-epic'
    | 'nested-epic'
    | 'missing-epic-branch'
    | 'ambiguous-epic-branch'
    | 'open-pr-base-mismatch'
    | 'multiple-completing-prs'
  message: string
}

export interface IssueDeliveryContext {
  repository: string
  issue: {
    number: number
    state: 'OPEN' | 'CLOSED'
    kind: PlanningRecordReport['record']['issue']['kind']
    areas: string[]
    parent: PlanningRecordReport['record']['issue']['parent']
  }
  parent: null | {
    number: number
    state: 'OPEN' | 'CLOSED'
    kind: PlanningRecordReport['record']['issue']['kind']
    planning: PlanningRecordReport['record']['project']
  }
  delivery: {
    path: 'ordinary' | 'epic-child'
    base: string | null
    branch: string
    worktree: string
  }
  planning: PlanningRecordReport['record']['project']
  openPullRequests: Array<{
    number: number
    base: string
    head: string
    relationships: Array<'closing' | 'completing-child' | 'contribution'>
  }>
  conflicts: IssueContextConflict[]
  ready: boolean
}

export async function readIssueDeliveryContext(
  port: IssueContextPort,
  input: IssueContextInput,
): Promise<IssueDeliveryContext> {
  const resolution = await resolveIssueDelivery(port, input.issueNumber)
  const record = resolution.issue
  const conflicts: IssueContextConflict[] = []
  const base = resolution.base
  const deliveryPath = resolution.path
  const parentContext: IssueDeliveryContext['parent'] =
    resolution.parent === null
      ? null
      : {
          number: resolution.parent.issue.number,
          state: resolution.parent.issue.state,
          kind: resolution.parent.issue.kind,
          planning: resolution.parent.project,
        }
  conflicts.push(...resolution.conflicts)

  if (record.issue.state === 'CLOSED') {
    conflicts.push({
      code: 'issue-closed',
      message: `Issue #${input.issueNumber} is closed. Reopen it before implementation.`,
    })
  }
  if (record.issue.kind.state !== 'valid') {
    conflicts.push({
      code: 'invalid-kind',
      message: `Issue #${input.issueNumber} does not have one valid recognized kind label.`,
    })
  }
  addPlanningConflicts(conflicts, record, `Issue #${input.issueNumber}`)

  if (resolution.parent !== null) {
    addPlanningConflicts(
      conflicts,
      resolution.parent,
      `Parent #${resolution.parent.issue.number}`,
    )
  }

  const openPullRequests = relatedOpenPullRequests(
    record,
    await port.listOpenPullRequestBodies(),
  )
  if (base !== null) {
    for (const pullRequest of openPullRequests) {
      if (pullRequest.base !== base) {
        conflicts.push({
          code: 'open-pr-base-mismatch',
          message: `Open PR #${pullRequest.number} targets ${pullRequest.base}; expected ${base}.`,
        })
      }
    }
  }
  if (
    openPullRequests.filter((pullRequest) =>
      pullRequest.relationships.includes('completing-child'),
    ).length > 1
  ) {
    conflicts.push({
      code: 'multiple-completing-prs',
      message: `Issue #${input.issueNumber} has more than one open completing-child PR.`,
    })
  }

  return {
    repository: record.repository,
    issue: {
      number: record.issue.number,
      state: record.issue.state,
      kind: record.issue.kind,
      areas: record.issue.areas,
      parent: record.issue.parent,
    },
    parent: parentContext,
    delivery: {
      path: deliveryPath,
      base,
      branch: `agent/issue-${input.issueNumber}`,
      worktree: join(`${input.primaryRoot}-worktrees`, `issue-${input.issueNumber}`),
    },
    planning: record.project,
    openPullRequests,
    conflicts,
    ready: conflicts.length === 0,
  }
}

function addPlanningConflicts(
  conflicts: IssueContextConflict[],
  record: PlanningRecordReport['record'],
  owner: string,
): void {
  if (record.project.membership !== 'present') {
    conflicts.push({
      code: 'project-membership',
      message: `${owner} is ${record.project.membership} in the canonical Project.`,
    })
    return
  }
  if (
    record.issue.kind.state === 'valid' &&
    record.issue.kind.option !== record.project.kind
  ) {
    conflicts.push({
      code: 'project-kind',
      message: `${owner} Project Kind does not match its repository kind label.`,
    })
  }
  const invalidStatus =
    record.issue.state === 'CLOSED'
      ? record.project.status !== 'Done'
      : record.project.status === null || record.project.status === 'Done'
  if (invalidStatus) {
    conflicts.push({
      code: 'project-status',
      message: `${owner} Project Status does not match its issue lifecycle state.`,
    })
  }
}

function relatedOpenPullRequests(
  record: PlanningRecordReport['record'],
  pullRequests: PullRequestBodySnapshot[],
): IssueDeliveryContext['openPullRequests'] {
  const relationships = new Map<
    number,
    Set<'closing' | 'completing-child' | 'contribution'>
  >()
  for (const linked of record.issue.linkedPullRequests) {
    if (linked.state === 'OPEN' && linked.relationship === 'closing') {
      addRelationship(relationships, linked.number, 'closing')
    }
  }
  for (const pullRequest of pullRequests) {
    if (pullRequest.repository.toLowerCase() !== record.repository.toLowerCase()) {
      continue
    }
    const completing = parseCompletingChildTrailer(pullRequest.body, pullRequest.number)
    if (completing.issueNumber === record.issue.number) {
      addRelationship(relationships, pullRequest.number, 'completing-child')
    }
    const contributions = parseContributionTrailers(pullRequest.body, pullRequest.number)
    if (contributions.issueNumbers.includes(record.issue.number)) {
      addRelationship(relationships, pullRequest.number, 'contribution')
    }
  }

  const snapshots = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  )
  return [...relationships]
    .map(([number, related]) => {
      const snapshot = snapshots.get(number)
      return {
        number,
        base: snapshot?.baseRefName ?? 'unknown',
        head: snapshot?.headRefName ?? 'unknown',
        relationships: ['closing', 'completing-child', 'contribution'].filter(
          (
            relationship,
          ): relationship is 'closing' | 'completing-child' | 'contribution' =>
            related.has(relationship as 'closing' | 'completing-child' | 'contribution'),
        ),
      }
    })
    .sort((first, second) => first.number - second.number)
}

function addRelationship(
  relationships: Map<number, Set<'closing' | 'completing-child' | 'contribution'>>,
  pullRequestNumber: number,
  relationship: 'closing' | 'completing-child' | 'contribution',
): void {
  const existing = relationships.get(pullRequestNumber) ?? new Set()
  existing.add(relationship)
  relationships.set(pullRequestNumber, existing)
}
