import type { AcceptedInstallation } from './installation-state'

export interface AgentAccessPrior {
  readonly activation: object
  readonly enabled: boolean
  readonly effective: boolean
  readonly intent: object | undefined
}
interface AgentSettingPorts {
  accepted(): readonly AcceptedInstallation[]
  activation(installation: string): object | undefined
  writable(): boolean
  authority: AbortSignal
  assertWritable(): Promise<void>
  serialize(operation: () => Promise<void>): Promise<void>
  save(next: AcceptedInstallation[], current: () => Promise<void>): Promise<void>
  publish(): void
}

/** Activation-owned agent intent/lifetime policy. Durable state remains in the activation writer. */
export class ActivationAgentAccess {
  private readonly lifetimes = new Map<string, AbortController>()
  private readonly revoked = new Set<string>()
  private readonly intents = new Map<string, object>()
  constructor(private readonly ports: AgentSettingPorts) {}

  allowed(): readonly string[] {
    if (!this.ports.writable()) return []
    return this.ports
      .accepted()
      .filter((entry) => entry.agentAccess && !this.revoked.has(entry.installationId))
      .map((entry) => entry.installationId)
  }
  signal(installation: string): AbortSignal {
    if (!this.allowed().includes(installation))
      throw new Error('Agent access for this extension is off')
    let lifetime = this.lifetimes.get(installation)
    if (!lifetime) {
      lifetime = new AbortController()
      this.lifetimes.set(installation, lifetime)
    }
    return AbortSignal.any([this.ports.authority, lifetime.signal])
  }
  end(installation: string): void {
    this.lifetimes.get(installation)?.abort()
    this.lifetimes.delete(installation)
  }
  retain(installations: ReadonlySet<string>): void {
    for (const id of this.revoked) if (!installations.has(id)) this.revoked.delete(id)
    for (const id of this.intents.keys())
      if (!installations.has(id)) this.intents.delete(id)
  }
  capture(installation: string): AgentAccessPrior {
    const activation = this.ports.activation(installation)
    const saved = this.ports
      .accepted()
      .find((entry) => entry.installationId === installation)
    if (!activation || !saved || !this.ports.writable())
      throw new Error('Extension agent setting is unavailable')
    return {
      activation,
      enabled: !!saved.agentAccess,
      effective: this.allowed().includes(installation),
      intent: this.intents.get(installation),
    }
  }
  configure(
    installation: string,
    enabled: boolean,
    prior?: AgentAccessPrior,
    current: () => void = () => {},
  ): Promise<void> {
    if (typeof installation !== 'string' || typeof enabled !== 'boolean')
      return Promise.reject(new Error('Invalid extension agent access'))
    if (!this.ports.writable()) return this.ports.assertWritable()
    if (!this.ports.accepted().some((entry) => entry.installationId === installation))
      return Promise.reject(new Error('Extension installation is unavailable'))
    const check = (intent: object | undefined) => {
      current()
      if (prior) {
        const now = this.capture(installation)
        if (
          now.activation !== prior.activation ||
          now.enabled !== prior.enabled ||
          now.intent !== intent
        )
          throw new Error('Extension agent setting changed; review setup again')
      }
    }
    try {
      check(prior?.intent)
    } catch (reason) {
      return Promise.reject(
        reason instanceof Error
          ? reason
          : new Error('Extension agent setting changed', { cause: reason }),
      )
    }
    const intent = {}
    this.intents.set(installation, intent)
    if (!enabled) {
      this.revoked.add(installation)
      this.end(installation)
      this.ports.publish()
    }
    return this.ports.serialize(async () => {
      await this.ports.assertWritable()
      if (!this.ports.accepted().some((entry) => entry.installationId === installation))
        throw new Error('Extension installation is unavailable')
      const live = async () => {
        await this.ports.assertWritable()
        check(intent)
      }
      await this.ports.save(
        this.ports
          .accepted()
          .map((entry) =>
            entry.installationId === installation
              ? { ...entry, agentAccess: enabled }
              : entry,
          ),
        live,
      )
      if (enabled && this.intents.get(installation) === intent)
        this.revoked.delete(installation)
      this.ports.publish()
    })
  }
}
