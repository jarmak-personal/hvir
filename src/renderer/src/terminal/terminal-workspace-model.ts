import {
  basenameHostPath,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProviderCapabilities,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HarnessTelemetry,
  type HostPath,
  type TerminalIdentityStatus,
} from '../../../shared'
import type { TerminalAttention } from './terminal-attention'
import { profileRiskAcknowledged } from './terminal-profile-recovery'

export type TerminalSplitPane = 'primary' | 'secondary'
export type TerminalStartMode = 'interactive' | 'bulk'

export interface TerminalSession {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly capabilities: HarnessProviderCapabilities
  readonly fallbackTitle: string
  readonly title: string
  readonly status: string
  readonly attention?: TerminalAttention
  readonly telemetry?: HarnessTelemetry
  readonly harnessSessionId?: string
  readonly identityStatus?: TerminalIdentityStatus
  readonly resumeOnStart: boolean
  /** Restored metadata exists, but no terminal engine or PTY has been allocated. */
  readonly dormant?: boolean
  /** Bulk starts alone use the main-owned per-host admission queue. */
  readonly startMode?: TerminalStartMode
  readonly pane: TerminalSplitPane
  /** Immutable provider launch/recovery context. */
  readonly cwd: HostPath
}

export interface TerminalWorkspaceModel {
  readonly sessions: readonly TerminalSession[]
  readonly activeId?: string
  readonly activePane: TerminalSplitPane
  readonly activeByPane: Readonly<Record<TerminalSplitPane, string | undefined>>
  readonly primaryWidth?: number
}

export type TerminalWorkspaceAction =
  | { readonly type: 'reset'; readonly primaryWidth?: number }
  | {
      readonly type: 'sessions-replaced'
      readonly sessions: readonly TerminalSession[]
      readonly activeId?: string
      readonly activeByPane?: Readonly<
        Record<TerminalSplitPane, string | undefined>
      >
    }
  | { readonly type: 'session-added'; readonly session: TerminalSession }
  | {
      readonly type: 'session-replaced'
      readonly id: string
      readonly session: TerminalSession
    }
  | { readonly type: 'session-focused'; readonly id: string }
  | { readonly type: 'session-updated'; readonly session: TerminalSession }
  | { readonly type: 'session-closed'; readonly id: string }
  | { readonly type: 'session-moved'; readonly id: string }
  | { readonly type: 'dormant-sessions-start-requested' }
  | { readonly type: 'primary-width-changed'; readonly width?: number }

export const initialTerminalWorkspaceModel: TerminalWorkspaceModel = {
  sessions: [],
  activePane: 'primary',
  activeByPane: { primary: undefined, secondary: undefined },
}

export function terminalWorkspaceReducer(
  model: TerminalWorkspaceModel,
  action: TerminalWorkspaceAction,
): TerminalWorkspaceModel {
  switch (action.type) {
    case 'reset':
      return { ...initialTerminalWorkspaceModel, primaryWidth: action.primaryWidth }
    case 'sessions-replaced':
      return replaceSessions(
        model,
        action.sessions,
        action.activeId,
        action.activeByPane,
      )
    case 'session-added':
      return {
        ...model,
        sessions: [...model.sessions, action.session],
        activeId: action.session.id,
        activePane: action.session.pane,
        activeByPane: {
          ...model.activeByPane,
          [action.session.pane]: action.session.id,
        },
      }
    case 'session-replaced':
      return replaceSession(model, action.id, action.session)
    case 'session-focused': {
      const session = model.sessions.find((candidate) => candidate.id === action.id)
      if (!session) return model
      return {
        ...model,
        sessions: model.sessions.map((candidate) => {
          if (candidate.id !== action.id) return candidate
          return requestTerminalStart(
            candidate.attention ? { ...candidate, attention: undefined } : candidate,
            'interactive',
          )
        }),
        activeId: session.id,
        activePane: session.pane,
        activeByPane: { ...model.activeByPane, [session.pane]: session.id },
      }
    }
    case 'session-updated': {
      const at = model.sessions.findIndex((session) => session.id === action.session.id)
      if (at < 0 || model.sessions[at] === action.session) return model
      const sessions = [...model.sessions]
      sessions[at] = action.session
      return { ...model, sessions }
    }
    case 'session-closed':
      return closeSession(model, action.id)
    case 'session-moved':
      return moveSession(model, action.id)
    case 'dormant-sessions-start-requested':
      return {
        ...model,
        sessions: model.sessions.map((session) =>
          requestTerminalStart(session, 'bulk'),
        ),
      }
    case 'primary-width-changed':
      return { ...model, primaryWidth: action.width }
  }
}

export function createTerminalSession(
  id: string,
  profile: HarnessProfile,
  provider: HarnessProviderDescriptor,
  cwd: HostPath,
  pane: TerminalSplitPane,
  riskAcknowledged = false,
  capabilities: HarnessProviderCapabilities = provider.capabilities,
): TerminalSession {
  const fallbackTitle = `${provider.displayName} · ${basenameHostPath(cwd)}`
  return {
    id,
    providerId: provider.id,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    riskAcknowledged: profileRiskAcknowledged(profile) || riskAcknowledged,
    capabilities,
    fallbackTitle,
    title: fallbackTitle,
    status: 'Starting…',
    resumeOnStart: false,
    dormant: false,
    startMode: 'interactive',
    pane,
    cwd,
  }
}

export function terminalWorkspaceSplit(model: TerminalWorkspaceModel): boolean {
  return model.sessions.some((session) => session.pane === 'secondary')
}

export function nextTerminalSplitPane(model: TerminalWorkspaceModel): TerminalSplitPane {
  if (!terminalWorkspaceSplit(model)) return 'secondary'
  return model.activePane === 'primary' ? 'secondary' : 'primary'
}

export function terminalPaneActiveId(
  model: TerminalWorkspaceModel,
  pane: TerminalSplitPane,
): string | undefined {
  const preferred = model.activeByPane[pane]
  return (
    model.sessions.find((session) => session.pane === pane && session.id === preferred)
      ?.id ?? model.sessions.find((session) => session.pane === pane)?.id
  )
}

function replaceSessions(
  model: TerminalWorkspaceModel,
  sessions: readonly TerminalSession[],
  requestedActiveId?: string,
  requestedActiveByPane?: Readonly<
    Record<TerminalSplitPane, string | undefined>
  >,
): TerminalWorkspaceModel {
  const active =
    sessions.find((session) => session.id === requestedActiveId) ?? sessions[0]
  const activeByPane = {
    primary:
      sessions.find(
        (session) =>
          session.pane === 'primary' &&
          session.id ===
            (requestedActiveByPane?.primary ?? model.activeByPane.primary),
      )?.id ?? sessions.find((session) => session.pane === 'primary')?.id,
    secondary:
      sessions.find(
        (session) =>
          session.pane === 'secondary' &&
          session.id ===
            (requestedActiveByPane?.secondary ?? model.activeByPane.secondary),
      )?.id ?? sessions.find((session) => session.pane === 'secondary')?.id,
  }
  if (active) activeByPane[active.pane] = active.id
  return {
    ...model,
    sessions,
    activeId: active?.id,
    activePane: active?.pane ?? 'primary',
    activeByPane,
  }
}

function closeSession(model: TerminalWorkspaceModel, id: string): TerminalWorkspaceModel {
  const index = model.sessions.findIndex((session) => session.id === id)
  if (index < 0) return model
  const pane = model.sessions[index]?.pane ?? 'primary'
  let sessions = model.sessions.filter((session) => session.id !== id)
  const nextInPane =
    sessions.slice(index).find((session) => session.pane === pane) ??
    [...sessions].reverse().find((session) => session.pane === pane)
  const activeByPane = { ...model.activeByPane }
  if (activeByPane[pane] === id) activeByPane[pane] = nextInPane?.id
  let active = sessions.find((session) => session.id === model.activeId)
  if (!active) {
    active = nextInPane ?? sessions[Math.min(index, sessions.length - 1)]
    if (active) activeByPane[active.pane] = active.id
  }
  if (active?.dormant) {
    sessions = sessions.map((session) =>
      session.id === active?.id
        ? requestTerminalStart(session, 'interactive')
        : session,
    )
  }
  return {
    ...model,
    sessions,
    activeId: active?.id,
    activePane: active?.pane ?? 'primary',
    activeByPane,
  }
}

function replaceSession(
  model: TerminalWorkspaceModel,
  id: string,
  replacement: TerminalSession,
): TerminalWorkspaceModel {
  const index = model.sessions.findIndex((session) => session.id === id)
  if (
    index < 0 ||
    (replacement.id !== id &&
      model.sessions.some((session) => session.id === replacement.id))
  ) {
    return model
  }
  const sessions = [...model.sessions]
  sessions[index] = replacement
  const activeByPane = { ...model.activeByPane }
  for (const pane of ['primary', 'secondary'] as const) {
    if (activeByPane[pane] === id) activeByPane[pane] = replacement.id
  }
  return {
    ...model,
    sessions,
    activeId: model.activeId === id ? replacement.id : model.activeId,
    activeByPane,
  }
}

function moveSession(model: TerminalWorkspaceModel, id: string): TerminalWorkspaceModel {
  const session = model.sessions.find((candidate) => candidate.id === id)
  if (!session) return model
  const pane: TerminalSplitPane = session.pane === 'primary' ? 'secondary' : 'primary'
  const activeByPane = { ...model.activeByPane }
  if (activeByPane[session.pane] === id) {
    activeByPane[session.pane] = model.sessions.find(
      (candidate) => candidate.pane === session.pane && candidate.id !== id,
    )?.id
  }
  activeByPane[pane] = id
  return {
    ...model,
    sessions: model.sessions.map((candidate) =>
      candidate.id === id
        ? requestTerminalStart({ ...candidate, pane }, 'interactive')
        : candidate,
    ),
    activeId: id,
    activePane: pane,
    activeByPane,
  }
}

function requestTerminalStart(
  session: TerminalSession,
  mode: TerminalStartMode,
): TerminalSession {
  if (!session.dormant) return session
  const action = session.resumeOnStart ? 'resume' : 'start'
  return {
    ...session,
    dormant: false,
    startMode: mode,
    status:
      mode === 'bulk'
        ? `Queued to ${action}`
        : session.resumeOnStart
          ? 'Resuming…'
          : 'Starting…',
  }
}
