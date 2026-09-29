import {
  SessionsProjectionCoordinator,
  createSessionsMainObservationPort,
} from '../src/renderer/src/sessions/sessions-projection-coordinator'
import type { SessionsRendererObservationPort } from '../src/renderer/src/sessions/sessions-renderer-observation'
import { SESSIONS_PROJECTION_VERSION, type HvirApi } from '../src/shared'

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
  const snapshot = {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    rows: [],
  } as const
  return {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    acquire: () => () => undefined,
  } as unknown as SessionsProjectionCoordinator
}
