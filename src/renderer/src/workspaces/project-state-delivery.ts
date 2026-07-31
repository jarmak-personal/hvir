import type { ProjectState } from '../../../shared'

/**
 * Applies main-owned project state through one ordered renderer gate.
 *
 * A lease follows the project-session subscription lifecycle. Revisions remain
 * remembered across lease replacement so React effect replay cannot reapply an
 * already accepted authoritative state.
 */
export class ProjectStateDelivery {
  private lease = 0
  private activeLease?: number
  private revision = -1

  constructor(private readonly apply: (state: ProjectState) => void) {}

  open(): () => void {
    const lease = (this.lease += 1)
    this.activeLease = lease
    return () => {
      if (this.activeLease === lease) this.activeLease = undefined
    }
  }

  accept(state: ProjectState): boolean {
    if (this.activeLease === undefined || state.revision <= this.revision) return false
    this.revision = state.revision
    this.apply(state)
    return true
  }
}
