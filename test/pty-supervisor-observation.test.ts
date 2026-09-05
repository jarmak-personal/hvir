import { describe, expect, it, vi } from 'vitest'
import type { HarnessTelemetryContext } from '../src/main/harness/harness-provider-contract'
import type { ProjectHost } from '../src/main/project-host'
import type { ManagedPty } from '../src/main/pty/pty-supervisor'
import {
  asHarnessProviderId,
  contextStatusHarnessSnapshot,
  localPath,
} from '../src/shared'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
  TestPtyProcess,
} from './fixtures/pty-supervisor-fixture'

const OWNER_ID = PTY_FIXTURE_OWNER_ID
const FakePty = TestPtyProcess
const fixture = createPtySupervisorFixture

describe('PTY supervisor observation composition', () => {
  it('publishes a session id discovered after launch', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    let finishIdentification: ((sessionId: string) => void) | undefined
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => Promise.resolve(['before'])),
        identify: vi.fn(
          () =>
            new Promise((resolve) => {
              finishIdentification = (sessionId) =>
                resolve({ status: 'identified', sessionId })
            }),
        ),
      },
    })
    const onIdentity = vi.fn<(info: ManagedPty) => void>()
    supervisor.onSessionIdentity(onIdentity)

    const initial = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'terminal-id',
    })
    expect(initial).toMatchObject({
      id: 'terminal-id',
      identityStatus: 'discovering',
      harnessSessionId: undefined,
    })
    expect(spawnPty).toHaveBeenCalledOnce()

    finishIdentification?.('codex-session-id')
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('terminal-id')).toMatchObject({
      harnessSessionId: 'codex-session-id',
      identityStatus: 'identified',
    })
  })

  it('re-arms unavailable identity discovery on later terminal input', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const snapshot = vi.fn(() => Promise.resolve(['pre-launch']))
    const identify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({
        status: 'identified',
        sessionId: 'codex-after-input',
      })
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: { snapshot, identify },
    })
    const onIdentity = vi.fn<(info: ManagedPty) => void>()
    supervisor.onSessionIdentity(onIdentity)

    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'terminal-before-input',
    })
    await vi.waitFor(() =>
      expect(onIdentity).toHaveBeenLastCalledWith(
        expect.objectContaining({ identityStatus: 'unavailable' }),
      ),
    )

    supervisor.write(info.id, OWNER_ID, 'first prompt')

    await vi.waitFor(() =>
      expect(supervisor.get(info.id)).toMatchObject({
        harnessSessionId: 'codex-after-input',
        identityStatus: 'identified',
      }),
    )
    expect(pty.write).toHaveBeenCalledWith('first prompt')
    expect(snapshot).toHaveBeenCalledOnce()
    expect(identify).toHaveBeenCalledTimes(2)
    expect(onIdentity.mock.calls.map(([value]) => value.identityStatus)).toEqual([
      'unavailable',
      'discovering',
      'identified',
    ])
  })

  it('does not let an input-triggered identity retry block a later PTY', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(firstPty).mockResolvedValueOnce(secondPty)
    let finishRetry: (() => void) | undefined
    const identify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = () => resolve({ status: 'unavailable' })
          }),
      )
      .mockResolvedValueOnce({ status: 'unavailable' })
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: () => Promise.resolve([]),
        identify,
      },
    })

    const first = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'retrying-terminal',
    })
    await vi.waitFor(() =>
      expect(supervisor.get(first.id)?.identityStatus).toBe('unavailable'),
    )
    supervisor.write(first.id, OWNER_ID, 'start')
    await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(2))

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'later-terminal',
    })

    expect(spawnPty).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(3))
    finishRetry?.()
  })

  it('passes cwd and replays the latest provider telemetry across attachments', async () => {
    const { supervisor, host, provider } = fixture()
    const pending = contextStatusHarnessSnapshot({
      providerId: asHarnessProviderId('test'),
      provenance: 'test fixture',
      sessionId: 'harness-session',
      context: { status: 'pending', reason: 'Waiting for test telemetry' },
    })
    const unavailable = contextStatusHarnessSnapshot({
      providerId: asHarnessProviderId('test'),
      provenance: 'test fixture',
      sessionId: 'harness-session',
      context: { status: 'unavailable', reason: 'Test telemetry unavailable' },
    })
    const disposeTelemetry = vi.fn()
    let emitTelemetry: HarnessTelemetryContext['emit'] | undefined
    const observe = vi.fn((_host: ProjectHost, context: HarnessTelemetryContext) => {
      emitTelemetry = context.emit
      context.emit(pending)
      return disposeTelemetry
    })
    Object.assign(provider, { telemetry: { observe } })

    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'telemetry-session',
    })
    const firstTelemetry = vi.fn()
    const detach = supervisor.attach(info.id, OWNER_ID, {
      onTelemetry: firstTelemetry,
    })

    await vi.waitFor(() => expect(firstTelemetry).toHaveBeenCalledWith(pending))
    expect(observe.mock.calls[0]?.[1].cwd).toEqual(localPath('/tmp/project'))

    void detach()
    emitTelemetry?.(unavailable)
    const reattachedTelemetry = vi.fn()
    supervisor.attach(info.id, OWNER_ID, { onTelemetry: reattachedTelemetry })

    expect(reattachedTelemetry).toHaveBeenCalledOnce()
    expect(reattachedTelemetry).toHaveBeenCalledWith(unavailable)
    supervisor.disposeOwner(OWNER_ID)
    await vi.waitFor(() => expect(disposeTelemetry).toHaveBeenCalledOnce())
  })

  it('publishes and replays a fixed unavailable snapshot when observation rejects', async () => {
    const { supervisor, host, provider } = fixture()
    Object.assign(provider, {
      telemetry: {
        observe: () => Promise.reject(new Error('/private/remote/transcript failed')),
      },
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'rejected-telemetry',
    })
    const firstTelemetry = vi.fn()
    const detach = supervisor.attach(info.id, OWNER_ID, {
      onTelemetry: firstTelemetry,
    })

    await vi.waitFor(() => expect(firstTelemetry).toHaveBeenCalledOnce())
    expect(firstTelemetry.mock.calls[0]?.[0]).toMatchObject({
      source: {
        providerId: 'test',
        provenance: 'Harness telemetry observer lifecycle',
      },
      facets: {
        session: {
          status: 'available',
          value: { id: 'rejected-telemetry', state: 'active' },
        },
        context: {
          status: 'unavailable',
          reason: 'Harness telemetry observer unavailable',
        },
      },
    })
    expect(JSON.stringify(firstTelemetry.mock.calls[0]?.[0])).not.toContain('/private')

    void detach()
    const reattachedTelemetry = vi.fn()
    supervisor.attach(info.id, OWNER_ID, { onTelemetry: reattachedTelemetry })
    expect(reattachedTelemetry).toHaveBeenCalledWith(firstTelemetry.mock.calls[0]?.[0])
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })

  it('retains identity subscriptions when only live sessions are disposed', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(firstPty).mockResolvedValueOnce(secondPty)
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => Promise.resolve([])),
        identify: vi
          .fn()
          .mockResolvedValueOnce({ status: 'identified', sessionId: 'harness-first' })
          .mockResolvedValueOnce({ status: 'identified', sessionId: 'harness-second' }),
      },
    })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-after-project-open',
    })
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledTimes(1))

    supervisor.disposeSessions()
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'second-after-project-open',
    })

    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledTimes(2))
    expect(onIdentity.mock.calls[1]?.[0]).toMatchObject({
      id: 'second-after-project-open',
      harnessSessionId: 'harness-second',
    })
  })

  it('serializes discovery launches without blocking later PTYs on identity', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    const order: string[] = []
    let finishFirstSpawn: (() => void) | undefined
    let releaseFirst: (() => void) | undefined
    let identifyCount = 0
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => {
          order.push('snapshot')
          return Promise.resolve([])
        }),
        identify: vi.fn(() => {
          identifyCount++
          order.push('identify')
          if (identifyCount === 1) {
            return new Promise((resolve) => {
              releaseFirst = () => resolve({ status: 'unavailable' })
            })
          }
          return Promise.resolve({ status: 'unavailable' })
        }),
      },
    })
    spawnPty.mockImplementationOnce(() => {
      order.push('spawn')
      return new Promise((resolve) => {
        finishFirstSpawn = () => resolve(firstPty)
      })
    })
    spawnPty.mockImplementationOnce(() => {
      order.push('spawn')
      return Promise.resolve(secondPty)
    })

    const firstSpawn = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-terminal',
    })
    await vi.waitFor(() => expect(order).toEqual(['snapshot', 'spawn']))
    const secondSpawn = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'second-terminal',
    })
    await Promise.resolve()
    expect(order).toEqual(['snapshot', 'spawn'])

    finishFirstSpawn?.()
    await firstSpawn
    await secondSpawn
    await vi.waitFor(() => expect(identifyCount).toBe(2))
    expect(order).toEqual([
      'snapshot',
      'spawn',
      'identify',
      'snapshot',
      'spawn',
      'identify',
    ])
    releaseFirst?.()
  })

  it('fails closed when discovered session identity is ambiguous', async () => {
    const { supervisor, host, provider } = fixture()
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: () => Promise.resolve([]),
        identify: () => Promise.resolve({ status: 'ambiguous' }),
      },
    })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'ambiguous-terminal',
    })
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('ambiguous-terminal')).toMatchObject({
      identityStatus: 'ambiguous',
      harnessSessionId: undefined,
    })
  })

  it('requires an exact id to resume a discovered session', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      resume: (ctx: { sessionId: string }) => ({
        file: 'test-harness',
        args: ['resume', ctx.sessionId],
      }),
    })

    await expect(
      supervisor.spawn({
        host,
        provider,
        cwd: localPath('/tmp/project'),
        ownerId: OWNER_ID,
        sessionId: 'new-terminal-id',
        resume: true,
      }),
    ).rejects.toThrow(/requires an exact session id/)

    const resumed = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'new-terminal-id',
      harnessSessionId: 'exact-harness-id',
      resume: true,
    })
    expect(resumed).toMatchObject({
      resumed: true,
      harnessSessionId: 'exact-harness-id',
      identityStatus: 'identified',
    })
    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['resume', 'exact-harness-id'] }),
    )
  })
})
