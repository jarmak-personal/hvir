import {
  hostPathEquals,
  type HarnessLaunchMode,
  type HarnessProfile,
  type HarnessProviderCapabilities,
  type HostPath,
  type StartPtyRequest,
} from '../../shared'
import type { ManagedPty } from '../pty/pty-supervisor'
import type { TerminalSessionStore } from './session-registry'

export function terminalLaunchMode(
  request: Pick<StartPtyRequest, 'launchMode' | 'resume'>,
): HarnessLaunchMode {
  const mode = request.launchMode ?? (request.resume === true ? 'resume' : 'fresh')
  if (
    !['fresh', 'resume', 'fork'].includes(mode) ||
    (request.resume === true && mode !== 'resume')
  ) {
    throw new Error('Invalid harness launch mode')
  }
  return mode
}

export function isAuthorizedTerminalFork(input: {
  readonly request: StartPtyRequest
  readonly capabilities: HarnessProviderCapabilities
  readonly providerSupportsFork: boolean
  readonly source: ManagedPty | undefined
  readonly profile: HarnessProfile
  readonly sessions: TerminalSessionStore
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
}): boolean {
  const { request, capabilities, source, profile, workspaceRoot, cwd } = input
  if (
    capabilities.exactFork !== true ||
    !input.providerSupportsFork ||
    !isTerminalId(request.forkSourceSessionId) ||
    !isHarnessSessionId(request.parentHarnessSessionId) ||
    !source ||
    source.providerId !== profile.providerId ||
    source.profileId !== profile.id ||
    source.launchRevision !== profile.launchRevision ||
    source.identityDiverged === true ||
    source.harnessSessionId !== request.parentHarnessSessionId ||
    !hostPathEquals(source.workspaceRoot, workspaceRoot) ||
    !hostPathEquals(source.cwd, cwd)
  ) {
    return false
  }
  return input.sessions.authorizeFork({
    sourceId: request.forkSourceSessionId,
    childId: request.sessionId,
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    parentHarnessSessionId: request.parentHarnessSessionId,
    workspaceRoot,
    cwd,
  })
}

export function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

export function isHarnessSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
