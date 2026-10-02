import { randomUUID } from 'node:crypto'
import {
  AGENT_LIMITS,
  type AgentAccessState,
  type AgentConfirmation,
  type AgentSettings,
} from '../../shared/agent/contract'

interface PendingConfirmation {
  readonly value: AgentConfirmation
  readonly finish: (accepted: boolean) => void
}
/** Standing authorization belongs to hvir, independently of any harness permission mode. */
export class LocalAgentAccessOwner {
  readonly instance = randomUUID()
  endpoint?: string
  explanation?: string
  private settings: AgentSettings = {
    enabled: false,
    confirmDestructive: false,
  }
  private generation = new AbortController()
  private readonly confirmations = new Map<string, PendingConfirmation>()
  private disposed = false
  private persistence: Promise<void> = Promise.resolve()
  constructor(
    private readonly changed: () => void,
    private readonly save: (settings: AgentSettings) => Promise<void>,
    private readonly extensions: {
      readonly allowed: () => readonly string[]
      readonly writable: () => boolean
      readonly signal: (id: string) => AbortSignal
    } = {
      allowed: () => [],
      writable: () => false,
      signal: () => {
        throw new Error('Extension actions are unavailable')
      },
    },
  ) {}
  snapshot(): AgentAccessState {
    return {
      ...this.settings,
      extensions: this.extensions.allowed(),
      extensionsWritable: this.extensions.writable(),
      instance: this.instance,
      endpoint: this.endpoint,
      confirmations: [...this.confirmations.values()].map((entry) => entry.value),
      explanation: this.explanation,
    }
  }
  restore(value: unknown): void {
    try {
      this.settings = validateAgentSettings(value)
    } catch {
      this.settings = { enabled: false, confirmDestructive: false }
    }
    this.changed()
  }
  async configure(value: unknown): Promise<void> {
    if (this.disposed) throw new Error('Agent access has ended')
    const next = validateAgentSettings(value)
    // All access changes revoke admitted lifetimes before persistence or later effects.
    this.generation.abort()
    for (const pending of [...this.confirmations.values()]) pending.finish(false)
    this.generation = new AbortController()
    this.settings = next
    this.changed()
    const generation = this.generation
    const saved = this.persistence.catch(() => undefined).then(() => this.save(next))
    this.persistence = saved
    try {
      await saved
    } catch (reason) {
      if (this.generation === generation && !this.disposed) {
        this.generation.abort()
        this.settings = { ...next, enabled: false }
        this.changed()
      }
      throw reason
    }
  }
  admit(signal: AbortSignal): {
    readonly signal: AbortSignal
    readonly current: () => void
  } {
    if (!this.settings.enabled || this.disposed)
      throw new Error('Agent access is off; enable it in Settings > Extensions')
    const combined = AbortSignal.any([signal, this.generation.signal])
    return {
      signal: combined,
      current: () => {
        combined.throwIfAborted()
        if (!this.settings.enabled || this.disposed)
          throw new Error('Agent access was revoked')
      },
    }
  }
  assertExtension(id: string): void {
    if (!this.extensions.allowed().includes(id))
      throw new Error('Agent access for this extension is off')
  }
  extensionSignal(id: string): AbortSignal {
    this.assertExtension(id)
    return this.extensions.signal(id)
  }
  async authorizeAction(
    binding: {
      readonly installation: string
      readonly title: string
      readonly input: string
      readonly workspace?: string
      readonly session?: string
      readonly effects: { readonly delete: boolean; readonly replace: boolean }
    },
    current: () => void,
    signal: AbortSignal,
  ): Promise<'standing' | 'interactive'> {
    current()
    this.assertExtension(binding.installation)
    const effects = (['delete', 'replace'] as const).filter(
      (effect) => binding.effects[effect],
    )
    if (!this.settings.confirmDestructive || !effects.length) return 'standing'
    if (this.confirmations.size >= AGENT_LIMITS.confirmations)
      throw new Error('Agent confirmation capacity is full')
    const id = randomUUID()
    const accepted = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        if (!this.confirmations.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelled)
        this.changed()
        resolve(value)
      }
      const cancelled = (): void => finish(false)
      const timer = setTimeout(cancelled, AGENT_LIMITS.confirmationMs)
      this.confirmations.set(id, {
        value: {
          id,
          title: binding.title.slice(0, 160),
          input: binding.input,
          workspace: binding.workspace,
          session: binding.session,
          effects,
          expiresAt: Date.now() + AGENT_LIMITS.confirmationMs,
        },
        finish,
      })
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) cancelled()
      else this.changed()
    })
    current()
    this.assertExtension(binding.installation)
    if (!accepted)
      throw new Error('Destructive action confirmation was cancelled or expired')
    return 'interactive'
  }
  decide(id: string, accept: boolean): void {
    if (typeof id !== 'string' || typeof accept !== 'boolean')
      throw new Error('Invalid trusted decision')
    const pending = this.confirmations.get(id)
    if (!pending || pending.value.expiresAt <= Date.now())
      throw new Error('Agent confirmation is stale')
    pending.finish(accept)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation.abort()
    for (const pending of [...this.confirmations.values()]) pending.finish(false)
  }
}
export function validateAgentSettings(value: unknown): AgentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent settings')
  const input = value as Record<string, unknown>
  if (
    typeof input['enabled'] !== 'boolean' ||
    typeof input['confirmDestructive'] !== 'boolean'
  )
    throw new Error('Invalid agent settings')
  return Object.freeze({
    enabled: input['enabled'],
    confirmDestructive: input['confirmDestructive'],
  })
}
