import { describe, expect, it } from 'vitest'

import { localPath } from '../src/shared'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
} from './fixtures/pty-supervisor-fixture'

describe('PtySupervisor usage observation', () => {
  it('qualifies the exact live PTY instance and revokes replacements or exits', async () => {
    const { supervisor, pty, host, provider } = createPtySupervisorFixture()
    const artifact = {
      identity: 'test-artifact',
      environment: { TEST_ARTIFACT: '/private/provider-artifact' },
      unsetEnvironment: ['OLD_TEST_ARTIFACT'],
    }
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: PTY_FIXTURE_OWNER_ID,
      sessionId: 'usage-session',
      artifact,
    })

    expect(supervisor.resolveUsageObservation(info.id, info.instanceId)).toEqual({
      status: 'available',
      target: {
        instanceId: info.instanceId,
        providerId: provider.manifest.id,
        host,
        sessionId: 'usage-session',
        cwd: localPath('/tmp/project'),
        sessionData: undefined,
        artifact,
      },
    })
    expect(supervisor.resolveUsageObservation(info.id, 'replaced-instance')).toEqual({
      status: 'unavailable',
    })

    pty.emitExit({ exitCode: 0, signal: undefined })
    expect(supervisor.resolveUsageObservation(info.id, info.instanceId)).toEqual({
      status: 'unavailable',
    })
  })
})
