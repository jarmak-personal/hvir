import type { TerminalEvent, TerminalPane } from './terminal-pane'
import {
  MAX_TERMINAL_SEMANTIC_REGIONS,
  TerminalSemanticRegions,
  type TerminalSemanticRegionDirection,
  type TerminalSemanticRegionSummary,
} from './terminal-semantic-regions'

export interface TerminalPaneEventSnapshot {
  readonly semanticRegionsAvailable: boolean
  readonly semanticRegion?: TerminalSemanticRegionSummary
}

export type TerminalPaneEventEffect = { readonly title: string } | { readonly bell: true }

/** Owns parser-event consumption and bounded, per-pane transcript navigation. */
export class TerminalPaneEventCoordinator {
  private readonly regions = new TerminalSemanticRegions()
  private readonly listeners = new Set<() => void>()
  private currentSnapshot: TerminalPaneEventSnapshot = {
    semanticRegionsAvailable: false,
  }
  private currentTitle: string
  private container?: HTMLElement

  constructor(private readonly fallbackTitle: string) {
    this.currentTitle = fallbackTitle
  }

  snapshot = (): TerminalPaneEventSnapshot => this.currentSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(container: HTMLElement): void {
    this.container = container
    this.updateTelemetry()
  }

  detach(container: HTMLElement): void {
    if (this.container === container) this.container = undefined
  }

  handle(event: TerminalEvent): TerminalPaneEventEffect | undefined {
    if (event.type === 'title') {
      const title = event.title.trim() || this.fallbackTitle
      if (title === this.currentTitle) return undefined
      this.currentTitle = title
      return { title }
    }
    if (
      event.type === 'bell' ||
      (event.type === 'notification' && event.source === 'osc-9')
    ) {
      return { bell: true }
    }
    if (event.type !== 'semantic') return undefined
    const changed = this.regions.consume(event)
    this.updateTelemetry()
    if (changed) this.publish()
    return undefined
  }

  navigate(direction: TerminalSemanticRegionDirection, pane: TerminalPane): void {
    const screen = pane.activeEventScreen()
    const plan = this.regions.navigationPlan(direction, screen, (provenance) =>
      pane.resolveEventProvenance(provenance),
    )
    const target = plan.candidates.find(({ location }) =>
      pane.revealEventLocation(location),
    )
    const summary = target
      ? this.regions.activate(target.id, screen, plan.resolved)
      : undefined
    if (plan.changed || target) this.publish(summary)
  }

  clear(): void {
    this.regions.clear()
    this.currentTitle = this.fallbackTitle
    this.updateTelemetry()
    this.publish()
  }

  private publish(semanticRegion?: TerminalSemanticRegionSummary): void {
    const semanticRegionsAvailable = this.regions.size > 0
    if (
      this.currentSnapshot.semanticRegionsAvailable === semanticRegionsAvailable &&
      regionEquals(this.currentSnapshot.semanticRegion, semanticRegion)
    ) {
      return
    }
    this.currentSnapshot = { semanticRegionsAvailable, semanticRegion }
    for (const listener of this.listeners) listener()
  }

  private updateTelemetry(): void {
    if (!this.container) return
    this.container.dataset.terminalSemanticRegions = String(this.regions.size)
    this.container.dataset.terminalSemanticRegionLimit = String(
      MAX_TERMINAL_SEMANTIC_REGIONS,
    )
  }
}

function regionEquals(
  left: TerminalSemanticRegionSummary | undefined,
  right: TerminalSemanticRegionSummary | undefined,
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.index === right?.index &&
    left?.total === right?.total
  )
}
