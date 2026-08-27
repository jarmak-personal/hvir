import type { TerminalEventRoute } from './terminal-event-router'
import type { TerminalPane, TerminalPresentation } from './terminal-pane'

/**
 * Owns the ordered lease between one retained terminal surface and its current
 * React container. Requested presentation is applied only while that lease exists.
 */
export class TerminalSurfaceAttachment {
  private current?: HTMLElement
  private retained?: HTMLElement
  private pane?: TerminalPane
  private route?: TerminalEventRoute
  private applied: TerminalPresentation = 'hidden'
  private workspacePresentation: TerminalPresentation = 'hidden'
  private lease?: {
    readonly generation: number
    container?: HTMLElement
    presentation: TerminalPresentation
  }
  private nextLeaseGeneration = 0
  private interactionRevision = 0

  get currentContainer(): HTMLElement | undefined {
    return this.current
  }

  get retainedContainer(): HTMLElement | undefined {
    return this.retained
  }

  get presentation(): TerminalPresentation {
    return this.applied
  }

  get interactionGeneration(): number {
    return this.interactionRevision
  }

  attach(container: HTMLElement, requested: TerminalPresentation): boolean {
    this.retained = container
    this.workspacePresentation = requested
    if (this.lease) return false
    if (this.current === container) {
      this.synchronize(requested)
      return false
    }
    this.moveTo(container)
    this.apply(requested)
    return true
  }

  detach(container: HTMLElement): void {
    if (this.current !== container || this.lease?.container) return
    this.apply('hidden')
    this.current = undefined
    this.interactionRevision += 1
  }

  mountPane(pane: TerminalPane, fallback: HTMLElement): void {
    this.pane = pane
    pane.setPresentation('hidden')
    this.applied = 'hidden'
    pane.mount(this.current ?? this.retained ?? fallback)
  }

  installRoute(route: TerminalEventRoute): void {
    this.route = route
    if (this.current) route.exposeStats(this.current)
    route.setPresentation(this.applied)
  }

  synchronize(requested: TerminalPresentation): void {
    this.workspacePresentation = requested
    if (!this.lease) this.apply(this.current ? requested : 'hidden')
  }

  hide(): void {
    this.apply('hidden')
  }

  canFocus(): boolean {
    return Boolean(this.current && this.pane && this.applied === 'visible')
  }

  canWorkspaceFocus(): boolean {
    return this.isWorkspaceCurrent() && this.canFocus()
  }

  isWorkspaceCurrent(): boolean {
    return Boolean(!this.lease && this.current === this.retained)
  }

  acquireLease(): number | undefined {
    if (this.lease || !this.pane) return undefined
    const generation = (this.nextLeaseGeneration += 1)
    this.apply('hidden')
    this.lease = { generation, presentation: 'hidden' }
    this.interactionRevision += 1
    return generation
  }

  attachLease(
    generation: number,
    container: HTMLElement,
    requested: TerminalPresentation,
  ): boolean {
    const lease = this.lease
    if (!lease || lease.generation !== generation) return false
    lease.presentation = requested
    if (lease.container === container && this.current === container) {
      this.apply(requested)
      return true
    }
    this.apply('hidden')
    lease.container = container
    this.moveTo(container)
    this.apply(requested)
    return true
  }

  setLeasePresentation(
    generation: number,
    container: HTMLElement,
    requested: TerminalPresentation,
  ): boolean {
    const lease = this.lease
    if (
      !lease ||
      lease.generation !== generation ||
      lease.container !== container ||
      this.current !== container
    ) {
      return false
    }
    lease.presentation = requested
    this.apply(requested)
    return true
  }

  detachLease(generation: number, container: HTMLElement): boolean {
    const lease = this.lease
    if (!lease || lease.generation !== generation || lease.container !== container) {
      return false
    }
    this.apply('hidden')
    lease.container = undefined
    lease.presentation = 'hidden'
    this.restoreWorkspace('hidden')
    return true
  }

  releaseLease(generation: number): boolean {
    if (!this.lease || this.lease.generation !== generation) return false
    this.apply('hidden')
    this.lease = undefined
    this.restoreWorkspace(this.workspacePresentation)
    return true
  }

  isCurrentLease(generation: number, container?: HTMLElement): boolean {
    return Boolean(
      this.lease?.generation === generation &&
      (container === undefined ||
        (this.lease.container === container && this.current === container)),
    )
  }

  releaseResources(): void {
    this.pane = undefined
    this.route = undefined
    this.lease = undefined
    this.applied = 'hidden'
    this.interactionRevision += 1
  }

  dispose(): void {
    this.hide()
    this.current = undefined
    this.retained = undefined
    this.lease = undefined
    this.releaseResources()
  }

  private apply(presentation: TerminalPresentation): void {
    if (this.applied === presentation) return
    this.applied = presentation
    this.interactionRevision += 1
    this.pane?.setPresentation(presentation)
    this.route?.setPresentation(presentation)
  }

  private moveTo(container: HTMLElement): void {
    if (this.current === container) return
    this.apply('hidden')
    this.current = container
    this.interactionRevision += 1
    if (!this.pane) return
    this.pane.reparent(container)
    this.route?.exposeStats(container)
  }

  private restoreWorkspace(presentation: TerminalPresentation): void {
    const retained = this.retained
    if (!retained) {
      this.current = undefined
      this.interactionRevision += 1
      return
    }
    this.moveTo(retained)
    this.apply(presentation)
  }
}
