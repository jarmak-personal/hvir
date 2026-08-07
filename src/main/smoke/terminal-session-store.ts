import type { TerminalSessionStore } from '../terminal/session-registry'
import { hostPathEquals, type HostPath, type TerminalRecoverySession } from '../../shared'

export function createSmokeTerminalSessionStore(defaultRoot: HostPath) {
  let sessions: readonly TerminalRecoverySession[] = []
  const roots = new Map<string, HostPath>()
  const sessionRoot = (id: string): HostPath => roots.get(id) ?? defaultRoot
  const store: TerminalSessionStore = {
    list: (root) =>
      sessions.filter((session) => hostPathEquals(sessionRoot(session.id), root)),
    get: (id) => {
      const session = sessions.find((candidate) => candidate.id === id)
      return session ? { ...session, workspaceRoot: sessionRoot(id) } : undefined
    },
    recordRecoveryDecision: () => Promise.resolve(),
    recordSpawn: () => Promise.resolve(),
    recordReplacement: () => Promise.resolve(),
    recordIdentity: () => Promise.resolve(true),
    cancelIdentityRegistration: () => undefined,
    updateLayout: () => Promise.resolve(),
    forget: (root, id) => {
      if (hostPathEquals(sessionRoot(id), root)) {
        sessions = sessions.filter((session) => session.id !== id)
        roots.delete(id)
      }
      return Promise.resolve()
    },
    rebindProfile: () => Promise.reject(new Error('Smoke recovery is read-only')),
    authorizeReattach: (request) => {
      const stored = sessions.find((session) => session.id === request.id)
      return Boolean(
        stored &&
        stored.providerId === request.providerId &&
        stored.profileId === request.profileId &&
        stored.launchRevision === request.launchRevision &&
        stored.harnessSessionId === request.harnessSessionId &&
        hostPathEquals(request.workspaceRoot, sessionRoot(stored.id)) &&
        hostPathEquals(stored.cwd, request.cwd),
      )
    },
    authorizeResume: () => false,
    authorizeReplacement: () => false,
    flush: () => Promise.resolve(),
  }
  return {
    store,
    set: (next: readonly TerminalRecoverySession[]): void => {
      sessions = next
      roots.clear()
    },
    add: (root: HostPath, session: TerminalRecoverySession): void => {
      sessions = [...sessions.filter((candidate) => candidate.id !== session.id), session]
      roots.set(session.id, root)
    },
    has: (root: HostPath, sessionId: string): boolean =>
      store.list(root).some((session) => session.id === sessionId),
  }
}
