import type { HarnessProviderDescriptor } from '../../../shared'
import type { TerminalSession } from './terminal-workspace-model'

export type TerminalForkAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string }

export function terminalForkAvailability(
  session: Pick<
    TerminalSession,
    | 'capabilities'
    | 'identityDiverged'
    | 'identityStatus'
    | 'harnessSessionId'
    | 'forkPending'
  >,
  provider: Pick<HarnessProviderDescriptor, 'exactForkLaunch'>,
  live: boolean,
): TerminalForkAvailability {
  if (!live) {
    return { available: false, reason: 'This terminal is no longer live.' }
  }
  if (provider.exactForkLaunch !== true) {
    return {
      available: false,
      reason: 'This harness provider does not support exact conversation forks.',
    }
  }
  if (session.capabilities.exactFork !== true) {
    return {
      available: false,
      reason: 'The probed harness version does not support exact conversation forks.',
    }
  }
  if (session.identityDiverged) {
    return {
      available: false,
      reason: 'The observed conversation identity diverged from this terminal.',
    }
  }
  if (session.identityStatus !== 'identified' || !session.harnessSessionId) {
    return {
      available: false,
      reason: 'This terminal does not have an exact current conversation identity.',
    }
  }
  if (session.forkPending) {
    return {
      available: false,
      reason: 'A conversation fork from this terminal is already starting.',
    }
  }
  return { available: true }
}
