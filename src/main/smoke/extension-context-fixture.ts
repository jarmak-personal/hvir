import type { ProjectState } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type {
  TerminalSessionStore,
  TerminalSessionObservationSource,
} from '../terminal/session-registry'
import { contextPorts } from '../application-document-surfaces'

/** Smoke composes the same read-only metadata port from its existing domain sources. */
export function extensionPtyPorts(
  ptySupervisor: PtySupervisor,
  terminalSessions: TerminalSessionStore & TerminalSessionObservationSource,
  projects: { get(): ProjectState; observe(listener: () => void): () => void },
) {
  return {
    ptySupervisor,
    terminalSessions,
    ...contextPorts(
      { state: () => projects.get(), observe: (listener) => projects.observe(listener) },
      terminalSessions,
      ptySupervisor,
    ),
  }
}
