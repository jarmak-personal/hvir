import { randomUUID } from 'node:crypto'
import type { AgentForwardState } from '../../shared/agent/contract'
import {
  StreamLocalForwardUnusedError,
  type ProjectHost,
  type StreamLocalBinding,
  type StreamLocalForward,
} from '../project-host/project-host'
import type { PtyAgentEnvironment } from '../pty/pty-contract'
import type { AgentStreamAdmission } from './stream-admission'
import type { AgentForwardScopeOwner } from './forward-scope'
import {
  RemoteClientCache,
  type CachedRemoteClient,
  type RemoteClientAsset,
} from './remote-client-cache'

interface Entry {
  readonly host: ProjectHost
  readonly binding: StreamLocalBinding
  readonly generation: string
  readonly availability: AbortController
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly disposeState: () => void | Promise<void>
  work?: Promise<PtyAgentEnvironment>
  cached?: CachedRemoteClient
  forwardUncertain?: boolean
  forward?: StreamLocalForward
  releaseWork?: Promise<void>
  state: AgentForwardState
}
/** Terminal-demand scoped detection/cache/forward lifetime; failure does not own ordinary SSH use. */
export class RemoteAgentClientOwner {
  private readonly entries = new Map<string, Entry>()
  private stopped = false
  private readonly preparations = new Set<Promise<PtyAgentEnvironment>>()
  constructor(
    private readonly ports: {
      readonly instance: string
      readonly enabled: () => boolean
      readonly assets: (target: string) => Promise<RemoteClientAsset>
      readonly admission: AgentStreamAdmission
      readonly scopes: AgentForwardScopeOwner
      readonly changed: () => void
    },
    private readonly cache = new RemoteClientCache(),
  ) {}
  snapshot(): readonly AgentForwardState[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry.state,
      grants: this.ports.scopes.grants(entry.host.hostId),
    }))
  }
  async environment(
    host: ProjectHost,
    launch: AbortSignal,
  ): Promise<PtyAgentEnvironment> {
    if (this.stopped || !this.ports.enabled())
      return unavailable('Agent access is off; enable it in Settings > Extensions')
    const binding = host.streamLocal
    if (!binding || host.connectionState !== 'connected')
      return unavailable(
        'hvir-agent is unavailable: the SSH host is disconnected or forwarding is unsupported',
      )
    let entry = this.entries.get(host.hostId)
    if (
      entry &&
      (entry.host !== host || entry.binding.generation !== binding.generation)
    ) {
      await this.close(entry)
      entry = undefined
    }
    if (!entry) {
      if (this.preparations.size >= 4)
        return unavailable(
          'SSH agent preparation capacity is full; unfinished host operations remain charged',
        )
      const controller = new AbortController(),
        availability = new AbortController(),
        lifecycle = AbortSignal.any([controller.signal, binding.signal]),
        signal = AbortSignal.any([lifecycle, availability.signal])
      const generation = `${binding.generation}:${randomUUID()}`
      let disposeState: () => void | Promise<void> = () => undefined
      entry = {
        host,
        binding,
        generation,
        availability,
        controller,
        signal,
        disposeState: () => disposeState(),
        state: {
          host: host.hostId,
          generation,
          availability: 'preparing',
          grants: [],
        },
      }
      this.entries.set(host.hostId, entry)
      const created = entry
      disposeState = host.onConnectionState((state) => {
        if (state !== 'connected') void this.close(created).catch(() => undefined)
      })
      lifecycle.addEventListener(
        'abort',
        () => {
          void this.close(created).catch(() => undefined)
        },
        { once: true },
      )
      const preparationSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      const physical = this.prepare(entry, preparationSignal)
      this.preparations.add(physical)
      void physical
        .finally(() => this.preparations.delete(physical))
        .catch(() => undefined)
      entry.work = boundedPreparation(physical, preparationSignal).catch(
        (reason: unknown) => {
          created.availability.abort()
          this.ports.scopes.revoke(host.hostId, created.generation)
          if (this.entries.get(host.hostId) === created) {
            created.state = {
              ...created.state,
              availability: 'unavailable',
              explanation:
                reason instanceof Error
                  ? reason.message.slice(0, 240)
                  : 'SSH agent access is unavailable',
            }
            this.ports.changed()
          }
          return unavailable(created.state.explanation ?? 'SSH agent access was revoked')
        },
      )
    }
    // Cancel this launch independently: other terminals may share the same bounded preparation.
    const result = await Promise.race([
      entry.work!,
      new Promise<PtyAgentEnvironment>((resolve) => {
        const cancelled = (): void =>
          resolve(unavailable('SSH agent setup was cancelled'))
        launch.addEventListener('abort', cancelled, { once: true })
        void entry.work!.finally(() => launch.removeEventListener('abort', cancelled))
        if (launch.aborted) cancelled()
      }),
    ])
    return result
  }
  private async prepare(entry: Entry, signal: AbortSignal): Promise<PtyAgentEnvironment> {
    const current = (): void => {
      signal.throwIfAborted()
      entry.binding.assertCurrent()
      if (
        this.stopped ||
        !this.ports.enabled() ||
        this.entries.get(entry.host.hostId) !== entry
      )
        throw new Error('SSH agent access was revoked')
    }
    const detected = await this.cache.detect(entry.host, signal)
    current()
    const asset = await this.ports.assets(detected.target)
    current()
    entry.cached = await this.cache.acquire(
      entry.host,
      detected.base,
      asset,
      this.ports.instance,
      entry.generation,
      signal,
    )
    try {
      current()
      this.ports.scopes.register(entry.host.hostId, entry.generation)
      entry.forwardUncertain = true
      entry.forward = await entry.binding.forward(entry.cached.socket, (stream) => {
        try {
          entry.signal.throwIfAborted()
          entry.binding.assertCurrent()
          this.ports.admission.accept(
            stream,
            {
              origin: 'ssh-forward',
              host: entry.binding.host,
              generation: entry.generation,
              lifetime: entry.signal,
              current: () => {
                entry.signal.throwIfAborted()
                entry.binding.assertCurrent()
                if (
                  !this.ports.enabled() ||
                  this.entries.get(entry.host.hostId) !== entry
                )
                  throw new Error('SSH agent access was revoked')
              },
            },
            entry.signal,
          )
        } catch {
          stream.destroy()
        }
      })
      entry.forwardUncertain = false
      current()
      entry.state = { ...entry.state, availability: 'ready' }
      this.ports.changed()
      return {
        env: {
          HVIR_AGENT_ENDPOINT: entry.cached.socket.path,
          HVIR_AGENT_CLIENT: entry.cached.client.path,
        },
        pathPrefix: entry.cached.directory,
      }
    } catch (reason) {
      if (reason instanceof StreamLocalForwardUnusedError) entry.forwardUncertain = false
      this.ports.scopes.revoke(entry.host.hostId, entry.generation)
      await this.release(entry)
      throw reason
    }
  }
  private async close(entry: Entry): Promise<void> {
    if (this.entries.get(entry.host.hostId) !== entry) return
    this.entries.delete(entry.host.hostId)
    this.ports.scopes.revoke(entry.host.hostId, entry.generation)
    entry.controller.abort()
    await entry.disposeState()
    this.ports.changed()
    await entry.work?.catch(() => undefined)
    await this.release(entry)
  }
  private release(entry: Entry): Promise<void> {
    // Uncertain physical startup keeps its lease for later bounded liveness reconciliation.
    if (entry.forwardUncertain || (!entry.cached && !entry.forward))
      return Promise.resolve()
    return (entry.releaseWork ??= (async () => {
      try {
        await entry.forward?.dispose()
        await entry.cached?.release()
      } catch {
        // An uncertain physical close keeps its lease. Later cache reconciliation probes liveness.
      }
    })())
  }
  async revoke(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.close(entry)))
  }
  async dispose(): Promise<void> {
    this.stopped = true
    await this.revoke()
  }
}
function unavailable(message: string): PtyAgentEnvironment {
  return { env: { HVIR_AGENT_UNAVAILABLE: message } }
}

function boundedPreparation(
  work: Promise<PtyAgentEnvironment>,
  signal: AbortSignal,
): Promise<PtyAgentEnvironment> {
  return new Promise((resolve, reject) => {
    const cancelled = (): void =>
      reject(
        new Error(
          'SSH agent setup was revoked or exceeded its 30 second preparation limit',
        ),
      )
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancelled))
  })
}
