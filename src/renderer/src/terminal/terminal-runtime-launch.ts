import type { StartPtyRequest, StartPtyResponse } from '../../../shared'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'

interface TerminalReplacement {
  readonly sessionId: string
  readonly replacesSessionId: string
}

interface TerminalLaunchStatusContext {
  readonly replacement?: TerminalReplacement
  readonly fork: boolean
  readonly resume: boolean
  readonly manualRestart: boolean
  readonly reconnect: boolean
}

export function terminalStartRequest(
  options: TerminalRuntimeOptions,
  sessionId: string,
  replacement: TerminalReplacement | undefined,
  size: Readonly<{ cols: number; rows: number }>,
  title: string,
  resume: boolean,
): StartPtyRequest {
  const fork = !replacement && !resume ? options.forkRequest : undefined
  return {
    sessionId,
    replacesSessionId: replacement?.replacesSessionId,
    profileId: options.profileId,
    launchRevision: options.launchRevision,
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    ...size,
    title,
    position: options.position,
    active: options.active,
    composerSubmitMode: options.composerSubmitMode,
    admission: options.startMode,
    ...(fork ? { launchMode: 'fork' as const } : {}),
    resume,
    harnessSessionId: resume ? options.harnessSessionId : undefined,
    forkSourceSessionId: fork?.sourceSessionId,
    parentHarnessSessionId: fork?.parentHarnessSessionId,
  }
}

export function terminalStartedStatus(
  result: Extract<StartPtyResponse, { outcome: 'started' }>,
  context: TerminalLaunchStatusContext,
): string {
  if (result.reattached) return `Reattached · pid ${result.pid}`
  if (result.resumed) return `Resumed · pid ${result.pid}`
  if (context.replacement) return `New session · pid ${result.pid}`
  if (context.fork) return `Forked · pid ${result.pid}`
  if (context.resume) return `New session · pid ${result.pid}`
  if (context.manualRestart) return `Restarted · pid ${result.pid}`
  if (context.reconnect) return `New shell · pid ${result.pid}`
  return `pid ${result.pid}`
}
