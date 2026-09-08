import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type SessionsDemandRequest,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsObservationSnapshot,
  type SessionsProjectionChange,
  type SessionsTerminalResolutionResponse,
  type SessionsUsageChange,
  type SessionsUsageDemandRequest,
  type SessionsUsageSnapshot,
} from '../sessions-projection'

export const sessionsIpc = {
  invoke: {
    'sessions:observe': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:snapshot': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:release': invoke<SessionsDemandRequest, void>(),
    'sessions:usage-observe': invoke<SessionsUsageDemandRequest, SessionsUsageSnapshot>(),
    'sessions:usage-snapshot': invoke<SessionsDemandRequest, SessionsUsageSnapshot>(),
    'sessions:usage-release': invoke<SessionsDemandRequest, void>(),
    'sessions:open': invoke<SessionsOpenRequest, SessionsOpenResponse>(),
    'sessions:resolve-terminal': invoke<
      SessionsOpenRequest,
      SessionsTerminalResolutionResponse
    >(),
  },
  send: {},
  event: {
    'sessions:changed': payload<SessionsProjectionChange>(),
    'sessions:usage-changed': payload<SessionsUsageChange>(),
  },
} satisfies IpcFeatureContract
