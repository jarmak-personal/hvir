import {
  captureTokenReceipt,
  type SessionTokenReceipt,
  type TokenReceiptPort,
} from './session-token-receipts.ts'
import {
  readIssueTokenSummary,
  type ContributorStatusPorts,
} from './contributor-status.ts'

export interface SessionTokenCapturePorts extends Pick<
  ContributorStatusPorts,
  'issue' | 'tokens'
> {
  observe: () => Promise<{ tokens: number } | { unavailable: string }>
  assign: (apply: boolean) => Promise<{ issue: number; receipt: string } | undefined>
  project: (issue: number, tokens: number | null) => Promise<void>
}

/** One operation owns capture and every retained derived write. Failures stay independent. */
export async function captureSessionTokens(
  ports: SessionTokenCapturePorts,
  input: {
    issue: number
    provider: SessionTokenReceipt['provider']
    apply: boolean
  },
): Promise<{ capture: string; observedTokens?: number; diagnostics: string[] }> {
  const diagnostics: string[] = []
  let capture: string
  let observedTokens: number | undefined
  try {
    const issue = await ports.issue(input.issue)
    const assignment = await ports.assign(false)
    const observation = await ports.observe()
    if ('tokens' in observation) observedTokens = observation.tokens
    if ('unavailable' in observation) capture = `unavailable (${observation.unavailable})`
    else if (!input.apply && !assignment) capture = 'would-assign-and-record'
    else {
      const selected = assignment ?? (await ports.assign(true))
      if (!selected || selected.issue !== input.issue)
        throw new Error('Session assignment unavailable.')
      capture = await captureTokenReceipt(
        ports.tokens,
        {
          schema: 2,
          issue: input.issue,
          receipt: selected.receipt,
          provider: input.provider,
          tokens: observation.tokens,
        },
        input.apply,
      )
    }
    if (input.apply) {
      const targets = [input.issue]
      if (issue.parent) {
        if (issue.parent.repository !== issue.repository)
          diagnostics.push('parent-projection-relationship-invalid')
        else targets.push(issue.parent.number)
      }
      for (const target of targets) {
        try {
          const summary = await readIssueTokenSummary(ports, target)
          if (
            summary.tokens === null ||
            summary.diagnostics.includes('conflicting-session-assignment') ||
            summary.diagnostics.includes('token-total-overflow')
          )
            throw new Error()
          diagnostics.push(...summary.diagnostics)
          await ports.project(target, summary.tokens)
        } catch {
          diagnostics.push(`token-projection-unavailable:#${target}`)
        }
      }
    }
  } catch (error) {
    capture =
      error instanceof Error &&
      error.message === 'Session already belongs to another issue.'
        ? 'session-already-assigned-to-another-issue'
        : 'unavailable-or-append-uncertain'
    diagnostics.push('capture-unavailable')
  }
  return {
    capture,
    ...(observedTokens === undefined ? {} : { observedTokens }),
    diagnostics,
  }
}

export type { TokenReceiptPort }
