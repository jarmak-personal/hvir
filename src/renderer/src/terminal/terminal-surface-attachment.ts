import type { TerminalEventRoute } from './terminal-event-router'
import type {
  TerminalPane,
  TerminalPresentation,
} from './terminal-pane'

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

  get currentContainer(): HTMLElement | undefined {
    return this.current
  }

  get retainedContainer(): HTMLElement | undefined {
    return this.retained
  }

  get presentation(): TerminalPresentation {
    return this.applied
  }

  attach(container: HTMLElement, requested: TerminalPresentation): boolean {
    if (this.current === container) {
      this.retained = container
      this.synchronize(requested)
      return false
    }
    this.apply('hidden')
    this.current = container
    this.retained = container
    if (!this.pane) return true
    this.pane.reparent(container)
    this.route?.exposeStats(container)
    this.synchronize(requested)
    return true
  }

  detach(container: HTMLElement): void {
    if (this.current !== container) return
    this.apply('hidden')
    this.retained = container
    this.current = undefined
  }

  mountPane(pane: TerminalPane, fallback: HTMLElement): void {
    this.pane = pane
    pane.setPresentation('hidden')
    pane.mount(this.current ?? this.retained ?? fallback)
  }

  installRoute(route: TerminalEventRoute): void {
    this.route = route
    if (this.current) route.exposeStats(this.current)
    route.setPresentation(this.applied)
  }

  synchronize(requested: TerminalPresentation): void {
    this.apply(this.current ? requested : 'hidden')
  }

  hide(): void {
    this.apply('hidden')
  }

  canFocus(): boolean {
    return Boolean(this.current && this.pane && this.applied === 'visible')
  }

  releaseResources(): void {
    this.pane = undefined
    this.route = undefined
    this.applied = 'hidden'
  }

  dispose(): void {
    this.hide()
    this.current = undefined
    this.retained = undefined
    this.releaseResources()
  }

  private apply(presentation: TerminalPresentation): void {
    this.applied = presentation
    this.pane?.setPresentation(presentation)
    this.route?.setPresentation(presentation)
  }
}
