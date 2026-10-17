import { expect, it, vi } from 'vitest'
import { asHostId, LOCAL_HOST_ID, joinHostPath } from '../src/shared/host-path'
import type { PtyAgentEnvironment } from '../src/main/pty/pty-contract'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
} from './fixtures/pty-supervisor-fixture'

it.each([LOCAL_HOST_ID, asHostId('ssh')])(
  'awaits trusted agent setup before %s PTY launch and protects its values',
  async (hostId) => {
    const f = createPtySupervisorFixture({ hostId, provider: plainShellProvider })
    const { spawnPty } = f
    let resolve!: (value: PtyAgentEnvironment) => void
    const pending = new Promise<PtyAgentEnvironment>((done) => {
      resolve = done
    })
    const provider = vi.fn(() => pending),
      prefix = joinHostPath(f.root, '.agent')
    f.supervisor.agentEnvironment(provider)
    try {
      const opening = f.spawn()
      await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
      expect(spawnPty).not.toHaveBeenCalled()
      resolve({
        env: {
          HVIR_AGENT_ENDPOINT: '/private/a.sock',
          HVIR_AGENT_CLIENT: '/private/hvir-agent',
        },
        pathPrefix: prefix,
      })
      await opening
      const options = spawnPty.mock.calls[0]?.[0]
      expect(options?.pathPrefix).toEqual(prefix)
      expect(options?.env).toMatchObject({
        HVIR_AGENT_ENDPOINT: '/private/a.sock',
        HVIR_AGENT_CLIENT: '/private/hvir-agent',
      })
      expect(options?.unsetEnv).toEqual(
        expect.arrayContaining([
          'HVIR_AGENT_ENDPOINT',
          'HVIR_AGENT_WORKSPACE',
          'HVIR_AGENT_SESSION',
          'HVIR_AGENT_CLIENT',
          'HVIR_AGENT_UNAVAILABLE',
        ]),
      )
    } finally {
      f.dispose()
    }
  },
)
it('unavailable agent setup leaves ordinary SSH terminal launch usable and late revoked setup cannot spawn', async () => {
  const f = createPtySupervisorFixture({
    hostId: asHostId('ssh'),
    provider: plainShellProvider,
  })
  const { spawnPty } = f
  f.supervisor.agentEnvironment(() =>
    Promise.resolve({ env: { HVIR_AGENT_UNAVAILABLE: 'forwarding unsupported' } }),
  )
  try {
    await f.spawn({ sessionId: 'ordinary' })
    expect(spawnPty.mock.calls[0]?.[0].env).toMatchObject({
      HVIR_AGENT_UNAVAILABLE: 'forwarding unsupported',
    })
    let resolve!: (value: PtyAgentEnvironment) => void
    const provider = vi.fn(
      () =>
        new Promise<PtyAgentEnvironment>((done) => {
          resolve = done
        }),
    )
    f.supervisor.agentEnvironment(provider)
    const opening = f.spawn({ sessionId: 'revoked' }),
      outcome = opening.catch((reason: unknown) => reason)
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
    f.supervisor.disposeOwner(PTY_FIXTURE_OWNER_ID)
    resolve({ env: { HVIR_AGENT_CLIENT: '/private/client' } })
    expect(await outcome).toBeInstanceOf(Error)
    expect(spawnPty).toHaveBeenCalledOnce()
  } finally {
    f.dispose()
  }
})
