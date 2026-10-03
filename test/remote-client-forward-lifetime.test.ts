import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { SshStreamLocalOwner } from '../src/main/project-host/ssh-stream-local'
import { SshTransportPool } from '../src/main/project-host/ssh-transport-pool'
import { RemoteAgentClientOwner } from '../src/main/agent/remote-client-owner'
import { RemoteClientCache } from '../src/main/agent/remote-client-cache'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { AgentStreamAdmission } from '../src/main/agent/stream-admission'
import { agentOutput } from '../src/shared/agent/contract'
import { asHostId, hostPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'

it('retains a rejected physical forward lease and fences new physical work until late reply/cancellation or transport close', async () => {
  vi.useFakeTimers()
  const event = new EventEmitter(),
    forwards: ((error?: Error) => void)[] = [],
    cancellations: (() => void)[] = []
  let delayedCancellation = false
  const request = vi.fn((_path: string, done: (error?: Error) => void) => {
    forwards.push(done)
  })
  const cancel = vi.fn((_path: string, done: () => void) => {
    if (delayedCancellation) cancellations.push(done)
    else done()
  })
  const client = Object.assign(event, {
    openssh_forwardInStreamLocal: request,
    openssh_unforwardInStreamLocal: cancel,
  }) as unknown as Client
  const lifecycle = new AbortController(),
    pool = new SshTransportPool({
      connected: () => Promise.resolve(client),
      assertTransportGrowthAllowed: () => undefined,
      openAuxiliaryTransport: () => Promise.reject(new Error('unsupported')),
      lifecycleSignal: () => lifecycle.signal,
    })
  pool.registerPrimary(client)
  const streamOwner = new SshStreamLocalOwner(pool),
    hostId = asHostId('ssh'),
    binding = streamOwner.binding(hostId, 1, client, () => true)
  const host = {
    hostId,
    connectionState: 'connected',
    streamLocal: binding,
    onConnectionState: () => () => undefined,
  } as unknown as ProjectHost
  const cached = {
    client: hostPath(hostId, '/private/client'),
    directory: hostPath(hostId, '/private/cache'),
    socket: hostPath(hostId, '/private/a.sock'),
    release: vi.fn(() => Promise.resolve()),
  }
  const cache = new RemoteClientCache(),
    admission = new AgentStreamAdmission(() => Promise.resolve(agentOutput({})))
  vi.spyOn(cache, 'detect').mockResolvedValue({
    target: 'macos-arm64',
    base: cached.directory,
  })
  const leases: (typeof cached)[] = []
  vi.spyOn(cache, 'acquire').mockImplementation(() => {
    const lease = { ...cached, release: vi.fn(() => Promise.resolve()) }
    leases.push(lease)
    return Promise.resolve(lease)
  })
  const remote = new RemoteAgentClientOwner(
    {
      instance: 'instance',
      enabled: () => true,
      assets: () =>
        Promise.resolve({ bytes: new Uint8Array(), sha256: '', target: 'macos-arm64' }),
      scopes: new AgentForwardScopeOwner(() => undefined),
      admission,
      changed: () => undefined,
    },
    cache,
  )
  const environment = () => remote.environment(host, new AbortController().signal)
  try {
    const first = environment()
    await vi.advanceTimersByTimeAsync(8001)
    expect((await first).env.HVIR_AGENT_UNAVAILABLE).toContain('timed out')
    expect(leases[0]?.release).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    await remote.revoke()
    expect((await environment()).env.HVIR_AGENT_UNAVAILABLE).toContain('unanswered')
    expect(request).toHaveBeenCalledOnce()
    expect(leases[0]?.release).not.toHaveBeenCalled()
    delayedCancellation = true
    forwards[0]!()
    const rejected = vi.fn(),
      accepted = vi.fn(() => new PassThrough())
    event.emit('unix connection', { socketPath: cached.socket.path }, accepted, rejected)
    expect(accepted).not.toHaveBeenCalled()
    expect(event.listenerCount('unix connection')).toBe(0)
    await remote.revoke()
    expect((await environment()).env.HVIR_AGENT_UNAVAILABLE).toContain('unanswered')
    expect(request).toHaveBeenCalledOnce()
    expect(leases[0]?.release).not.toHaveBeenCalled()
    cancellations.splice(0).forEach((done) => done())
    await remote.revoke()
    const fresh = environment()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
    forwards[1]!()
    expect((await fresh).env.HVIR_AGENT_ENDPOINT).toBe(cached.socket.path)
    delayedCancellation = false
    await remote.revoke()
    expect(leases[1]?.release).toHaveBeenCalledOnce()
    expect(leases[2]?.release).toHaveBeenCalledOnce()
    expect(leases[3]?.release).toHaveBeenCalledOnce()
    expect(leases[0]?.release).not.toHaveBeenCalled()
  } finally {
    event.emit('close')
    lifecycle.abort()
    await remote.dispose()
    streamOwner.revoke()
    pool.dispose()
    admission.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
