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

export type TerminalPaneEventEffect =
  | { readonly title: string }
  | { readonly bell: true }
  | { readonly clipboardWrite: { readonly selection: string; readonly data: string } }

/** Owns parser-event consumption and bounded, per-pane transcript navigation. */
export class TerminalPaneEventCoordinator {
  private readonly regions = new TerminalSemanticRegions()
  private readonly listeners = new Set<() => void>()
  private currentSnapshot: TerminalPaneEventSnapshot = {
    semanticRegionsAvailable: false,
  }
  private currentTitle: string
  private container?: HTMLElement
  private pane?: TerminalPane
  private highlightSubmittedInput: boolean
  private synchronizedSubmittedInputIds: readonly number[] = []

  constructor(
    private readonly fallbackTitle: string,
    highlightSubmittedInput = true,
  ) {
    this.currentTitle = fallbackTitle
    this.highlightSubmittedInput = highlightSubmittedInput
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

  bind(pane: TerminalPane): void {
    this.pane = pane
    this.synchronizeSubmittedInputDecorations(true)
  }

  unbind(): void {
    this.pane?.setSubmittedInputDecorations([])
    this.pane = undefined
    this.synchronizedSubmittedInputIds = []
  }

  setHighlightSubmittedInput(enabled: boolean): void {
    if (enabled === this.highlightSubmittedInput) return
    this.highlightSubmittedInput = enabled
    this.synchronizeSubmittedInputDecorations()
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
    if (event.type === 'clipboard') {
      // A read query would hand the local clipboard to the remote host that
      // asked for it; hvir answers only the write direction, never the read.
      // The payload stays encoded here: decoding it is clipboard policy, not
      // event translation.
      return event.operation === 'write'
        ? { clipboardWrite: { selection: event.selection, data: event.data } }
        : undefined
    }
    if (event.type !== 'semantic') return undefined
    const changed = this.regions.consume(event)
    this.synchronizeSubmittedInputDecorations()
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
    if (plan.changed) this.synchronizeSubmittedInputDecorations()
    if (plan.changed || target) this.publish(summary)
  }

  extractCurrentRegion(pane: TerminalPane, signal: AbortSignal): Promise<string> {
    const range = this.regions.currentCopyRange(pane.activeEventScreen())
    if (!range)
      return Promise.reject(new Error('No semantic terminal region is available'))
    const end = range.end ?? pane.captureRetainedBufferBoundary()
    if (!end)
      return Promise.reject(new Error('The current terminal region is unavailable'))
    return pane.extractRetainedBufferRange(range.start, end, { signal })
  }

  clear(): void {
    this.regions.clear()
    this.synchronizeSubmittedInputDecorations()
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

  private synchronizeSubmittedInputDecorations(force = false): void {
    const decorations = this.highlightSubmittedInput
      ? this.regions.completedCommandDecorations()
      : []
    const ids = decorations.map(({ id }) => id)
    if (
      !force &&
      ids.length === this.synchronizedSubmittedInputIds.length &&
      ids.every((id, index) => id === this.synchronizedSubmittedInputIds[index])
    ) {
      return
    }
    this.synchronizedSubmittedInputIds = ids
    this.pane?.setSubmittedInputDecorations(decorations)
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
