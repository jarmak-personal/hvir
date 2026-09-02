import { describe, expect, it, vi } from 'vitest'

import type { HarnessTelemetryContext } from '../src/main/harness/harness-provider'
import type { ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
} from './fixtures/pty-supervisor-fixture'

describe('PtySupervisor identity divergence', () => {
  it('publishes provider-observed divergence once as a sticky terminal fact', async () => {
    const { supervisor, host, provider } = createPtySupervisorFixture()
    let reportDivergence: (() => void) | undefined
    Object.assign(provider, {
      telemetry: {
        observe: (_host: ProjectHost, context: HarnessTelemetryContext) => {
          reportDivergence = context.identityDiverged
          return () => undefined
        },
      },
    })
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: PTY_FIXTURE_OWNER_ID,
      sessionId: 'identity-divergence',
    })
    const identity = vi.fn()
    const stop = supervisor.onSessionIdentity(identity)
    await vi.waitFor(() => expect(reportDivergence).toBeTypeOf('function'))

    reportDivergence?.()
    reportDivergence?.()

    expect(supervisor.get(info.id)).toMatchObject({ identityDiverged: true })
    expect(identity).toHaveBeenCalledOnce()
    expect(identity).toHaveBeenCalledWith(
      expect.objectContaining({ id: info.id, identityDiverged: true }),
    )
    await stop()
  })
})
