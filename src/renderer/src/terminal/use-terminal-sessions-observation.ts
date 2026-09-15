import { useEffect, type RefObject } from 'react'
import {
  asSessionsTerminalHandle,
  sessionsProjectionDisplayTitle,
  type HostPath,
  type HarnessProviderDescriptor,
  type SessionsWorkspaceQualifier,
} from '../../../shared'
import type { SessionsRendererSession } from '../sessions/sessions-renderer-observation'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import {
  settledTerminalSessions,
  type TerminalWorkspaceModel,
} from './terminal-workspace-model'

/** Publishes the existing workspace session projection without owning terminal behavior. */
export function useTerminalSessionsObservation({
  workspaceId,
  label,
  workspaceRoot,
  sessionsWorkspaceQualifier,
  providers,
  modelRef,
  runtimes,
  onSessionsSource,
}: {
  readonly workspaceId: string
  readonly label: string
  readonly workspaceRoot: HostPath
  readonly sessionsWorkspaceQualifier: SessionsWorkspaceQualifier
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly modelRef: RefObject<TerminalWorkspaceModel>
  readonly runtimes: TerminalRuntimeRegistry
  readonly onSessionsSource: (
    workspaceId: string,
    source: (() => readonly SessionsRendererSession[]) | undefined,
  ) => void
}): void {
  useEffect(() => {
    onSessionsSource(workspaceId, () =>
      settledTerminalSessions(modelRef.current.sessions).map((session) => {
        const runtime = runtimes.sessionSnapshot(session.id)
        const handle = asSessionsTerminalHandle(session.id)
        const providerName =
          providers.find((provider) => provider.id === session.providerId)?.displayName ??
          String(session.providerId)
        return {
          handle,
          workspaceQualifier: sessionsWorkspaceQualifier,
          providerId: session.providerId,
          profileId: session.profileId,
          title: sessionsProjectionDisplayTitle(
            session.title,
            handle,
            `${providerName} · ${label}`,
            [workspaceRoot.path, session.cwd.path, session.harnessSessionId ?? ''],
          ),
          dormant: session.dormant === true,
          resumeOnStart: session.resumeOnStart,
          exited: runtime?.exited === true,
          recoveryUnavailable: runtime?.recoveryFailure !== undefined,
          attention: session.attention,
        }
      }),
    )
    return () => onSessionsSource(workspaceId, undefined)
  }, [
    modelRef,
    label,
    onSessionsSource,
    providers,
    runtimes,
    sessionsWorkspaceQualifier,
    workspaceId,
    workspaceRoot.path,
  ])
}
