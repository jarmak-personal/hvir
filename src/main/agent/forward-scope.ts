import type { AgentConnection } from './stream-admission'
import type { AgentForwardGrant, AgentForwardState } from '../../shared/agent/contract'

interface ForwardScope {
  readonly host: string
  readonly generation: string
  controller: AbortController
  readonly grants: Map<string, AgentForwardGrant>
}
/** Server-owned remote scope and trusted grants; no request or guest data creates a scope. */
export class AgentForwardScopeOwner {
  private readonly scopes = new Map<string, ForwardScope>()
  constructor(private readonly changed: () => void) {}
  register(host: string, generation: string): void {
    this.revoke(host)
    this.scopes.set(host, {
      host,
      generation,
      controller: new AbortController(),
      grants: new Map(),
    })
    this.changed()
  }
  revoke(host: string, generation?: string): void {
    if (generation !== undefined && this.scopes.get(host)?.generation !== generation)
      return
    this.scopes.get(host)?.controller.abort()
    this.scopes.delete(host)
    this.changed()
  }
  revokeAll(): void {
    for (const host of [...this.scopes.keys()]) this.revoke(host)
  }
  signal(connection: AgentConnection): AbortSignal {
    return connection.origin === 'application-local'
      ? connection.signal
      : AbortSignal.any([connection.signal, this.scope(connection).controller.signal])
  }
  viewSignal(
    connection: Extract<AgentConnection, { origin: 'ssh-forward' }>,
  ): AbortSignal {
    return AbortSignal.any([
      connection.lifetime ?? connection.signal,
      this.scope(connection).controller.signal,
    ])
  }
  assertTarget(connection: AgentConnection, host?: string): void {
    if (connection.origin === 'application-local') return
    this.scope(connection)
    if (host && host !== connection.host)
      throw new Error('This SSH forward cannot target a local or other-host workspace')
  }
  assertCapability(
    connection: AgentConnection,
    binding: {
      installation: string
      revision: string
      action: string
      workspace?: string
    },
    capability: string,
    host: string,
    workspace?: string,
  ): void {
    if (connection.origin === 'application-local') return
    const scope = this.scope(connection)
    if (workspace && workspace !== binding.workspace)
      throw new Error('Action capability cannot change its admitted destination')
    if (host === connection.host) return
    if (
      ![...scope.grants.values()].some(
        (grant) =>
          grant.installation === binding.installation &&
          grant.revision === binding.revision &&
          grant.action === binding.action &&
          grant.workspace === binding.workspace &&
          grant.capability === capability &&
          grant.executionHost === host,
      )
    )
      throw new Error(
        'This SSH action requires a specific additional host capability grant in Settings > Extensions',
      )
  }
  configure(grant: AgentForwardGrant, enabled: boolean): void {
    const scope = this.scopes.get(grant.host)
    if (!scope || scope.generation !== grant.generation)
      throw new Error('SSH forward is stale or unavailable')
    const key = JSON.stringify(grant)
    if (enabled && scope.grants.size >= 32 && !scope.grants.has(key))
      throw new Error('SSH additional-grant capacity is full')
    if (enabled) scope.grants.set(key, Object.freeze({ ...grant }))
    else scope.grants.delete(key)
    // Interrupt pending actions and connector effects before old grant authority can be reused.
    scope.controller.abort()
    scope.controller = new AbortController()
    this.changed()
  }
  grants(host: string): readonly AgentForwardGrant[] {
    return [...(this.scopes.get(host)?.grants.values() ?? [])]
  }
  grantStates(): readonly Pick<AgentForwardState, 'host' | 'generation' | 'grants'>[] {
    return [...this.scopes.values()].map(({ host, generation, grants }) => ({
      host,
      generation,
      grants: [...grants.values()],
    }))
  }
  private scope(
    connection: Extract<AgentConnection, { origin: 'ssh-forward' }>,
  ): ForwardScope {
    connection.current()
    const scope = this.scopes.get(connection.host)
    if (!scope || scope.generation !== connection.generation)
      throw new Error('SSH agent forward was revoked')
    scope.controller.signal.throwIfAborted()
    return scope
  }
}
