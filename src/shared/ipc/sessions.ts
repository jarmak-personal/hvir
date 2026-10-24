import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type SessionsDemandRequest,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsObservationSnapshot,
  type SessionsProjectionChange,
  type SessionsTerminalResolutionResponse,
} from '../sessions-projection'

export const sessionsIpc = {
  invoke: {
    'sessions:observe': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:snapshot': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:release': invoke<SessionsDemandRequest, void>(),
    'sessions:open': invoke<SessionsOpenRequest, SessionsOpenResponse>(),
    'sessions:resolve-terminal': invoke<
      SessionsOpenRequest,
      SessionsTerminalResolutionResponse
    >(),
  },
  send: {},
  event: {
    'sessions:changed': payload<SessionsProjectionChange>(),
  },
} satisfies IpcFeatureContract
