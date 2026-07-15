import { describe, expect, it } from 'vitest'

import { initialHostConnectionTarget } from '../src/renderer/src/workspaces/initial-host-connection'
import {
  asHostId,
  hostPath,
  type HostConnectionState,
  type ProjectState,
} from '../src/shared'

describe('initial host connection', () => {
  it('requests one startup connection only for an idle active SSH host', () => {
    expect(initialHostConnectionTarget(state('local', 'disconnected'))).toBeUndefined()
    expect(initialHostConnectionTarget(state('remote', 'connected'))).toBeUndefined()
    expect(initialHostConnectionTarget(state('remote', 'connecting'))).toBeUndefined()
    expect(initialHostConnectionTarget(state('remote', 'reconnecting'))).toBeUndefined()
    expect(initialHostConnectionTarget(state('remote', 'disconnected'))).toBe('remote')
    expect(initialHostConnectionTarget(state('remote', 'failed'))).toBe('remote')
  })
})

function state(hostId: string, connectionState: HostConnectionState): ProjectState {
  return {
    root: hostPath(asHostId(hostId), '/project'),
    connectionState,
    watchTier: hostId === 'local' ? 'native' : 'polling',
    projects: [],
    activeProjectId: '',
    activeWorkspaceId: '',
  }
}
