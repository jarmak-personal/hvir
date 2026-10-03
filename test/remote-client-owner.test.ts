import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { RemoteAgentClientOwner } from '../src/main/agent/remote-client-owner'
import { RemoteClientCache } from '../src/main/agent/remote-client-cache'
import { AgentStreamAdmission } from '../src/main/agent/stream-admission'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { agentOutput } from '../src/shared/agent/contract'
import { asHostId, hostPath } from '../src/shared/host-path'
import type {
  ProjectHost,
  StreamLocalForward,
} from '../src/main/project-host/project-host'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function fixture() {
  const lifecycle = new AbortController(),
    scopes = new AgentForwardScopeOwner(() => undefined),
    dispatch = vi.fn(() => Promise.resolve(agentOutput({}))),
    admission = new AgentStreamAdmission(dispatch)
  const cached = {
    client: hostPath(asHostId('ssh'), '/tmp/client'),
    directory: hostPath(asHostId('ssh'), '/tmp/cache'),
    socket: hostPath(asHostId('ssh'), '/tmp/a.sock'),
    release: vi.fn(() => Promise.resolve()),
  }
  const forward: StreamLocalForward = {
    signal: new AbortController().signal,
    dispose: vi.fn(() => Promise.resolve()),
  }
  const binding = {
    host: asHostId('ssh'),
    generation: 'host-object:1',
    signal: lifecycle.signal,
    assertCurrent: () => lifecycle.signal.throwIfAborted(),
    forward: vi.fn((_path, _incoming) => Promise.resolve(forward)),
  }
  const host = {
    hostId: asHostId('ssh'),
    connectionState: 'connected',
    streamLocal: binding,
    onConnectionState: () => () => undefined,
  } as unknown as ProjectHost
  const cache = new RemoteClientCache(),
    detect = vi
      .spyOn(cache, 'detect')
      .mockResolvedValue({ target: 'macos-arm64', base: cached.directory }),
    acquire = vi.spyOn(cache, 'acquire').mockResolvedValue(cached),
    assets = vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array(), sha256: '', target: 'macos-arm64' }),
    )
  const owner = new RemoteAgentClientOwner(
    {
      instance: 'instance',
      enabled: () => true,
      assets,
      admission,
      scopes,
      changed: () => undefined,
    },
    cache,
  )
  return {
    owner,
    host,
    binding,
    cache,
    acquire,
    detect,
    assets,
    cached,
    scopes,
    lifecycle,
    forward,
    admission,
    dispatch,
    environment: () => owner.environment(host, new AbortController().signal),
  }
}
it('shares setup across terminals and gives each Off/re-enable a fresh grant identity', async () => {
  const f = fixture(),
    [a, b] = await Promise.all([f.environment(), f.environment()])
  expect(a).toEqual(b)
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.binding.forward).toHaveBeenCalledOnce()
  const old = f.owner.snapshot()[0]!.generation
  await f.owner.revoke()
  expect(f.cached.release).toHaveBeenCalledOnce()
  await f.environment()
  expect(f.owner.snapshot()[0]!.generation).not.toBe(old)
  await f.owner.dispose()
  f.admission.dispose()
})
it('bounds unavailable metadata/assets and Off while retaining unfinished physical preparation capacity', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const f = fixture(),
    pending = deferred<{ target: string; base: ReturnType<typeof hostPath> }>()
  f.detect.mockReturnValue(pending.promise)
  const starting = f.environment()
  await vi.advanceTimersByTimeAsync(30_001)
  expect((await starting).env.HVIR_AGENT_UNAVAILABLE).toContain('30 second')
  expect(f.owner.snapshot()[0]?.availability).toBe('unavailable')
  await f.owner.revoke()
  f.detect.mockResolvedValue({ target: 'macos-arm64', base: f.cached.directory })
  const assets = Array.from({ length: 3 }, () =>
    deferred<Awaited<ReturnType<typeof f.assets>>>(),
  )
  for (const asset of assets) {
    f.assets.mockReturnValueOnce(asset.promise)
    const opening = f.environment()
    await Promise.resolve()
    await Promise.resolve()
    await f.owner.revoke()
    await opening
  }
  expect((await f.environment()).env.HVIR_AGENT_UNAVAILABLE).toContain('capacity')
  pending.resolve({ target: 'macos-arm64', base: f.cached.directory })
  assets.forEach((asset) =>
    asset.resolve({ bytes: new Uint8Array(), sha256: '', target: 'macos-arm64' }),
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(f.acquire).not.toHaveBeenCalled()
  expect((await f.environment()).env.HVIR_AGENT_ENDPOINT).toBe('/tmp/a.sock')
  await f.owner.dispose()
  f.admission.dispose()
})
it('rejects late ingress/results after timeout and an old setup cannot revoke a newer forward', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const f = fixture(),
    late = deferred<StreamLocalForward>()
  f.binding.forward.mockReturnValueOnce(late.promise)
  const old = f.environment()
  await vi.advanceTimersByTimeAsync(0)
  const incoming = f.binding.forward.mock.calls[0]![1] as (stream: PassThrough) => void
  await vi.advanceTimersByTimeAsync(30_001)
  expect((await old).env.HVIR_AGENT_UNAVAILABLE).toBeDefined()
  const rejected = new PassThrough()
  incoming(rejected)
  expect(rejected.destroyed).toBe(true)
  await f.owner.revoke()
  expect(f.cached.release).not.toHaveBeenCalled()
  await f.environment()
  const generation = f.owner.snapshot()[0]!.generation
  late.resolve(f.forward)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.scopes.grantStates()[0]?.generation).toBe(generation)
  expect(f.owner.snapshot()[0]?.availability).toBe('ready')
  await f.owner.dispose()
  f.admission.dispose()
})
it('retains a lease when physical forward close is uncertain', async () => {
  const f = fixture()
  await f.environment()
  vi.spyOn(f.forward, 'dispose').mockRejectedValue(new Error('physical close uncertain'))
  await f.owner.dispose()
  expect(f.cached.release).not.toHaveBeenCalled()
  f.admission.dispose()
})
