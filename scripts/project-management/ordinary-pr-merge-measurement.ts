import { createHash } from 'node:crypto'

import type {
  AgentWorkRecord,
  NormalizedAgentWorkLedger,
  NormalizedAgentWorkRecord,
} from './agent-work-ledger.ts'

export interface OrdinaryMergeAcceptanceIdentity {
  issueNumber: number
  pullRequestNumber: number
  candidateOid: string
}

export interface OrdinaryMergeAcceptanceCorrection {
  record?: AgentWorkRecord
  candidateMismatch: boolean
  measurement: {
    outcome:
      | 'deferred'
      | 'already-reconciled'
      | 'sticky-rework'
      | 'unavailable'
      | 'candidate-mismatch'
    firstPass?: 'accepted' | 'rework-required'
  }
}

export function planOrdinaryMergeAcceptanceCorrection(
  ledger: NormalizedAgentWorkLedger,
  identity: OrdinaryMergeAcceptanceIdentity,
): OrdinaryMergeAcceptanceCorrection {
  const activeRuns = activeImplementationRuns(ledger)
  const candidateRuns = activeRuns.filter(
    (record) => record.outcome?.candidateRef !== undefined,
  )
  const exactCandidate = candidateRuns.find(
    (record) => record.outcome?.candidateRef === identity.candidateOid,
  )
  if (candidateRuns.length === 0) {
    return { candidateMismatch: false, measurement: { outcome: 'unavailable' } }
  }
  if (exactCandidate === undefined) {
    return {
      candidateMismatch: true,
      measurement: { outcome: 'candidate-mismatch' },
    }
  }

  const firstCandidate = candidateRuns[0]!
  if (candidateRuns.some((record) => record.outcome?.firstPass === 'rework-required')) {
    return {
      candidateMismatch: false,
      measurement: { outcome: 'sticky-rework', firstPass: 'rework-required' },
    }
  }
  if (firstCandidate.outcome?.firstPass === 'accepted') {
    return {
      candidateMismatch: false,
      measurement: { outcome: 'already-reconciled', firstPass: 'accepted' },
    }
  }

  const firstIndex = activeRuns.indexOf(firstCandidate)
  const hasLaterImplementationRun = activeRuns.slice(firstIndex + 1).length > 0
  const firstPass = hasLaterImplementationRun ? 'rework-required' : 'accepted'
  return {
    candidateMismatch: false,
    record: supersedingOutcomeRecord(firstCandidate, identity, firstPass),
    measurement: { outcome: 'deferred', firstPass },
  }
}

function activeImplementationRuns(
  ledger: NormalizedAgentWorkLedger,
): NormalizedAgentWorkRecord[] {
  const implementation = ledger.records.filter(
    (record) => record.phase === 'implementation',
  )
  const firstOrdinalByRun = new Map<string, number>()
  for (const record of implementation) {
    const existing = firstOrdinalByRun.get(record.runKey)
    if (existing === undefined || record.commentOrdinal < existing) {
      firstOrdinalByRun.set(record.runKey, record.commentOrdinal)
    }
  }
  return implementation
    .filter((record) => record.activity === 'active')
    .sort(
      (first, second) =>
        (firstOrdinalByRun.get(first.runKey) ?? first.commentOrdinal) -
        (firstOrdinalByRun.get(second.runKey) ?? second.commentOrdinal),
    )
}

function supersedingOutcomeRecord(
  target: NormalizedAgentWorkRecord,
  identity: OrdinaryMergeAcceptanceIdentity,
  firstPass: 'accepted' | 'rework-required',
): AgentWorkRecord {
  const {
    commentOrdinal: _commentOrdinal,
    activity: _activity,
    supersededBy: _supersededBy,
    ...record
  } = target
  return {
    ...record,
    idempotencyKey: acceptanceIdempotencyKey(identity, target.idempotencyKey, firstPass),
    outcome: {
      firstPass,
      ...(target.outcome?.candidateRef === undefined
        ? {}
        : { candidateRef: target.outcome.candidateRef }),
    },
    supersedes: target.idempotencyKey,
  }
}

function acceptanceIdempotencyKey(
  identity: OrdinaryMergeAcceptanceIdentity,
  supersededKey: string,
  firstPass: 'accepted' | 'rework-required',
): string {
  return createHash('sha256')
    .update(
      `hvir-ordinary-merge-acceptance-v1\0${identity.issueNumber}\0${identity.pullRequestNumber}\0${identity.candidateOid}\0${supersededKey}\0${firstPass}`,
    )
    .digest('hex')
}
