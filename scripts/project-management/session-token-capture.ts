import { createHash } from 'node:crypto'
import {
  captureTokenReceipt,
  type SessionTokenReceipt,
} from './session-token-receipts.ts'
import {
  readIssueTokenSummary,
  type ContributorStatusPorts,
} from './contributor-status.ts'
import {
  allocationIssues,
  allocationShares,
  type SessionAllocation,
  type TokenPhase,
  type TokenTotals,
} from './session-token-allocation.ts'

export interface SessionTokenCapturePorts extends Pick<
  ContributorStatusPorts,
  'issue' | 'tokens'
> {
  observe: () => Promise<{ tokens: number } | { unavailable: string }>
  assign: (apply: boolean) => Promise<{ issue: number; receipt: string } | undefined>
  allocate: (input: {
    assignment: { issue: number; receipt: string }
    issues: number[]
    phase: TokenPhase
    observed: number
    legacyFloor: number
    apply: boolean
  }) => Promise<SessionAllocation[]>
  project: (issue: number, totals: TokenTotals) => Promise<void>
}

/** One operation owns immutable allocation, receipt replay, and derived projection. */
export async function captureSessionTokens(
  ports: SessionTokenCapturePorts,
  input: {
    issue: number
    issues?: number[]
    phase: TokenPhase
    provider: SessionTokenReceipt['provider']
    apply: boolean
  },
): Promise<{
  capture: string
  observedTokens?: number
  shares?: { issue: number; tokens: number; phase: TokenPhase }[]
  diagnostics: string[]
}> {
  const diagnostics: string[] = []
  let observedTokens: number | undefined
  const shares: { issue: number; tokens: number; phase: TokenPhase }[] = []
  try {
    const issues = allocationIssues(input.issues ?? [input.issue])
    if (
      !issues.includes(input.issue) ||
      (input.phase !== 'planning' && issues.length !== 1)
    )
      throw new Error('Only planning captures may share multiple issues.')
    const selectedIssues = await Promise.all(issues.map((number) => ports.issue(number)))
    if (selectedIssues.some((row) => row.repository !== selectedIssues[0]!.repository))
      throw new Error('Cross-repository allocation.')
    let assignment = await ports.assign(false)
    const observation = await ports.observe()
    if ('unavailable' in observation)
      return { capture: `unavailable (${observation.unavailable})`, diagnostics }
    observedTokens = observation.tokens
    if (!assignment && input.apply) assignment = await ports.assign(true)
    // A preview identity exists only in memory; dry runs never create private state.
    assignment ??= { issue: input.issue, receipt: '0'.repeat(64) }
    const anchorHistory = await ports.tokens.read(assignment.issue)
    if (anchorHistory.diagnostics.length)
      throw new Error('Anchor token history incomplete.')
    const legacyFloor = Math.max(
      0,
      ...anchorHistory.receipts
        .filter((row) => row.schema === 2 && row.receipt === assignment.receipt)
        .map((row) => row.tokens),
    )
    const allocations = await ports.allocate({
      assignment,
      issues,
      phase: input.phase,
      observed: observation.tokens,
      legacyFloor,
      apply: input.apply,
    })
    let changed = false
    const targets = new Set<number>()
    for (const allocation of allocations) {
      for (const share of allocationShares(allocation)) {
        const receipt: SessionTokenReceipt = {
          schema: 3,
          ...share,
          phase: allocation.phase,
          provider: input.provider,
          receipt: createHash('sha256')
            .update(`${allocation.key}:${share.issue}`)
            .digest('hex'),
        }
        const result = await captureTokenReceipt(ports.tokens, receipt, input.apply)
        if (result !== 'unchanged') {
          changed = true
          shares.push({ ...share, phase: allocation.phase })
        }
        targets.add(share.issue)
      }
    }
    if (input.apply) {
      for (const target of [...targets]) {
        const issue = await ports.issue(target)
        if (issue.parent) {
          if (issue.parent.repository !== issue.repository)
            throw new Error('Invalid parent relationship.')
          targets.add(issue.parent.number)
        }
      }
      for (const target of targets) {
        try {
          const summary = await readIssueTokenSummary(ports, target)
          // Incomplete reads must never overwrite a more complete persisted projection.
          if (summary.tokens === null || summary.diagnostics.length) throw new Error()
          await ports.project(target, summary)
        } catch {
          diagnostics.push(`token-projection-unavailable:#${target}`)
        }
      }
    }
    return {
      capture: changed ? (input.apply ? 'recorded' : 'would-record') : 'unchanged',
      observedTokens,
      shares,
      diagnostics,
    }
  } catch (error) {
    const reason =
      error instanceof Error
        ? (
            {
              'Provider counters decreased; allocation unavailable.':
                'provider-counter-reset',
              'Concurrent allocation; retry capture.': 'concurrent-allocation-retry',
              'Anchor token history incomplete.': 'anchor-evidence-incomplete',
            } as Record<string, string>
          )[error.message]
        : undefined
    return {
      capture: reason ? `unavailable (${reason})` : 'unavailable-or-append-uncertain',
      ...(observedTokens === undefined ? {} : { observedTokens }),
      diagnostics: [...diagnostics, 'capture-unavailable'],
    }
  }
}
