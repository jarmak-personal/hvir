import type { ProjectState } from '../../shared'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { TerminalSessionObservationSource } from './session-registry'

/** Raw main-owned metadata sources, independent of screen demand, projections, and providers. */
export interface LiveSessionMetadataSources {
  readonly projectState: () => ProjectState
  readonly ptys: PtyObservationSource
  readonly sessions: TerminalSessionObservationSource
  readonly observeProjects: (listener: () => void) => () => void
}

export function liveSessionMetadataSources(
  sources: LiveSessionMetadataSources,
): LiveSessionMetadataSources {
  return {
    projectState: sources.projectState,
    ptys: sources.ptys,
    sessions: sources.sessions,
    observeProjects: sources.observeProjects,
  }
}
