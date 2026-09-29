import {
  SessionsProjectionCoordinator,
  createSessionsMainObservationPort,
} from '../src/renderer/src/sessions/sessions-projection-coordinator'
import type { SessionsRendererObservationPort } from '../src/renderer/src/sessions/sessions-renderer-observation'
import {
  SESSIONS_PROJECTION_VERSION,
  type HvirApi,
  type SessionsObservationSnapshot,
} from '../src/shared'

const emptyRenderer: SessionsRendererObservationPort = {
  snapshot: () => [],
  subscribe: () => () => undefined,
}

export function sessionsProjectionFixture(
  renderer: SessionsRendererObservationPort = emptyRenderer,
  api?: Pick<HvirApi, 'invoke' | 'on'>,
): SessionsProjectionCoordinator {
  if (api)
    return new SessionsProjectionCoordinator(
      createSessionsMainObservationPort(api),
      renderer,
    )
  return new SessionsProjectionCoordinator(
    {
      observe: (demandGeneration) => Promise.resolve(emptySnapshot(demandGeneration)),
      snapshot: (demandGeneration) => Promise.resolve(emptySnapshot(demandGeneration)),
      release: () => Promise.resolve(),
      subscribe: () => () => undefined,
    },
    renderer,
  )
}

function emptySnapshot(demandGeneration: number): SessionsObservationSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 0,
    workspaces: [],
    providers: [],
    sessions: [],
  }
}
