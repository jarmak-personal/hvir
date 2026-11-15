import type { NativeBoundarySource } from './native-terminal-query-boundaries'

// ABI 9 SemanticBoundaries uses a fixed, successful-capture-only round robin.
// Tokens remain opaque: 512 later distinct observed captures on this Surface
// prove replacement, even if additional native captures were not delivered.
const NATIVE_BOUNDARY_SLOTS = 512
interface Lease {
  readonly token: string
  readonly serial: number
  gone: boolean
}
interface Surface {
  source: NativeBoundarySource
  retiredThrough: number
  readonly window: Lease[]
  readonly leases: Map<string, Lease>
  readonly pending: Set<Lease>
  running?: Promise<void>
}

/** Owns early parser-pin retirement independently of PTY feed completion. */
export class NativeTerminalSemanticRetirement {
  private readonly surfaces = new Map<string, Surface>()
  constructor(
    private readonly close: (
      source: NativeBoundarySource,
      token: string,
    ) => Promise<void>,
    private readonly failed: (source: NativeBoundarySource) => void,
  ) {}

  observe(source: NativeBoundarySource, token: string, serial: number): void {
    const surface = this.surface(source)
    if (serial <= surface.retiredThrough || surface.leases.has(token)) return
    const lease = { token, serial, gone: false }
    // Serial ordering also handles a copied older batch arriving after a control
    // or owner transfer. Only distinct genuinely later captures prove replacement.
    let index = surface.window.length
    while (index && surface.window[index - 1]!.serial > serial) index--
    surface.window.splice(index, 0, lease)
    surface.leases.set(token, lease)
    if (surface.window.length > NATIVE_BOUNDARY_SLOTS) {
      const prior = surface.window.shift()!
      prior.gone = true
      surface.retiredThrough = prior.serial
      surface.pending.delete(prior)
      surface.leases.delete(prior.token)
    }
  }

  retire(source: NativeBoundarySource, token: string): void {
    const surface = this.surface(source)
    const lease = surface.leases.get(token)
    // An older observed token outside this window is already proven replaced.
    if (!lease || lease.gone) return
    surface.pending.add(lease)
    this.pump(surface)
  }

  wake(source: NativeBoundarySource): void {
    const surface = this.surfaces.get(source.session.instanceId)
    if (surface && surface.source.handle === source.handle) {
      surface.source = source
      this.pump(surface)
    }
  }

  /** Physical Surface destruction certifies every remaining pin is gone. */
  forgetDestroyed(instanceId: string): void {
    const surface = this.surfaces.get(instanceId)
    if (!surface) return
    for (const lease of surface.leases.values()) lease.gone = true
    surface.pending.clear()
    this.surfaces.delete(instanceId)
  }

  private surface(source: NativeBoundarySource): Surface {
    const id = source.session.instanceId
    const current = this.surfaces.get(id)
    if (current) {
      if (current.source.handle !== source.handle)
        throw new Error('native-semantic-retirement-instance-mismatch')
      current.source = source
      return current
    }
    const created: Surface = {
      source,
      retiredThrough: 0,
      window: [],
      leases: new Map(),
      pending: new Set(),
    }
    this.surfaces.set(id, created)
    return created
  }

  private pump(surface: Surface): void {
    if (surface.running || !surface.pending.size) return
    let failed = false
    surface.running = Promise.resolve()
      .then(async () => {
        while (this.surfaces.get(surface.source.session.instanceId) === surface) {
          const lease = surface.pending.values().next().value
          if (!lease) return
          try {
            await this.close(surface.source, lease.token)
            lease.gone = true
            surface.pending.delete(lease)
          } catch {
            if (lease.gone) continue // Replacement/destruction already certified it.
            // Keep the exact physical lease. A later causal wake can retry it;
            // there is no idle polling or forgotten failed close.
            failed = true
            try {
              this.failed(surface.source)
            } catch {
              /* Physical ownership remains retained. */
            }
            return
          }
        }
      })
      .finally(() => {
        surface.running = undefined
        // A causal retirement can arrive after the loop observed an empty set
        // but before this completion clears running. Drain that work, while a
        // failed close remains paused until a later causal wake.
        if (!failed) this.pump(surface)
      })
  }
}
