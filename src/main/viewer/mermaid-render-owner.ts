import {
  assertMermaidRequest,
  assertMermaidOutput,
  MERMAID_LIMITS,
  type MermaidRenderRequest,
} from '../../shared/presentation/mermaid-contract'
import type { RendererOwner } from '../renderer-resource-scopes'

export interface MermaidComputation {
  readonly result: Promise<string>
  dispose(): void
}
export interface MermaidComputationPort {
  start(request: MermaidRenderRequest): MermaidComputation
}

/** Finite jobs, no queue/cache; physical cancellation owns the browser lifetime. */
export class MermaidRenderOwner {
  private readonly jobs = new Map<string, () => void>()
  constructor(private readonly port: MermaidComputationPort) {}

  async render(owner: RendererOwner, request: MermaidRenderRequest): Promise<string> {
    assertMermaidRequest(request)
    const key = this.key(owner, request.id)
    if (this.jobs.has(key) || this.jobs.size >= MERMAID_LIMITS.activeJobs)
      throw new Error(
        'Diagram preview unavailable: rendering capacity reached. Reopen Rendered to retry.',
      )
    const job = this.port.start(request)
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      job.dispose()
    }
    let rejectRevoked!: (error: Error) => void
    const revoked = new Promise<never>((_resolve, reject) => {
      rejectRevoked = reject
    })
    const cancel = (): void => {
      if (this.jobs.get(key) !== cancel) return
      this.jobs.delete(key)
      try {
        dispose()
      } finally {
        rejectRevoked(new Error('Diagram rendering cancelled or timed out'))
      }
    }
    this.jobs.set(key, cancel)
    const deadline = setTimeout(cancel, MERMAID_LIMITS.deadlineMs)
    try {
      const svg = await Promise.race([job.result, revoked])
      if (this.jobs.get(key) !== cancel) throw new Error('Diagram rendering revoked')
      assertMermaidOutput(svg)
      return svg
    } finally {
      clearTimeout(deadline)
      if (this.jobs.get(key) === cancel) this.jobs.delete(key)
      dispose()
    }
  }

  cancel(owner: RendererOwner, id?: string): void {
    const prefix = `${owner.id}:${owner.generation}:`
    for (const [key, cancel] of this.jobs)
      if (id === undefined ? key.startsWith(prefix) : key === this.key(owner, id))
        cancel()
  }

  private key(owner: RendererOwner, id: string): string {
    return `${owner.id}:${owner.generation}:${id}`
  }
}
