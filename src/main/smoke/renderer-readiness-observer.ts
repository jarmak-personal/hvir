import type { RendererOwner } from '../renderer-resource-scopes'

/** Observes only readiness accepted by the production window owner. */
export class SmokeRendererReadiness {
  private readonly listeners = new Set<(owner: RendererOwner) => void>()
  accept(owner: RendererOwner): void {
    for (const listener of this.listeners) listener(owner)
  }
  async withReplacement<T>(
    initial: RendererOwner,
    run: (ready: Promise<RendererOwner>) => Promise<T>,
  ): Promise<T> {
    let accept!: (owner: RendererOwner) => void
    const ready = new Promise<RendererOwner>((resolve) => {
      accept = (owner) => {
        if (owner.id !== initial.id || owner.generation !== initial.generation)
          resolve(owner)
      }
    })
    this.listeners.add(accept)
    try {
      return await run(ready)
    } finally {
      this.listeners.delete(accept)
    }
  }
}
