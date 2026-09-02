import type { ManagedPty } from '../pty/pty-supervisor'
import type { StartPtyResponse } from '../../shared'

type StartedPtyResponse = Extract<StartPtyResponse, { outcome: 'started' }>

export function terminalStartedResponse(
  managed: ManagedPty,
  reattached: boolean,
): StartedPtyResponse {
  return {
    outcome: 'started',
    id: managed.id,
    instanceId: managed.instanceId,
    pid: managed.pid,
    harnessSessionId: managed.harnessSessionId,
    identityStatus: managed.identityStatus,
    ...(managed.identityDiverged ? { identityDiverged: true as const } : {}),
    capabilities: managed.capabilities,
    resumed: managed.resumed,
    reattached,
  }
}
