import { LOCAL_HOST_ID, type HostId, type ProjectState } from '../../../shared'

/**
 * Return the one remote host that startup should connect automatically.
 * In-flight hosts already own their attempt; connected and local hosts need none.
 */
export function initialHostConnectionTarget(state: ProjectState): HostId | undefined {
  if (state.root.hostId === LOCAL_HOST_ID) return undefined
  return state.connectionState === 'disconnected' || state.connectionState === 'failed'
    ? state.root.hostId
    : undefined
}
