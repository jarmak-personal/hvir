import {
  isNativeTerminalPane,
  type TerminalEvent,
  type TerminalRuntimePane,
} from './terminal-pane'
import { legacyTerminalRetainedQuery } from './terminal-retained-query'
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
  private navigationAbort?: AbortController
  private navigationCandidate?: number
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

  cancelNavigation(): void {
    this.navigationAbort?.abort()
    this.navigationCandidate = undefined
  }

  detach(container: HTMLElement): void {
    this.cancelNavigation()
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
    if (event.type === 'clipboard') {
      // A read query would hand the local clipboard to the remote host that
      // asked for it; hvir answers only the write direction, never the read.
      // The payload stays encoded here: decoding it is clipboard policy, not
      // event translation.
      return event.operation === 'write'
        ? { clipboardWrite: { selection: event.selection, data: event.data } }
        : undefined
    }
    if (event.type === 'semantic-gap') {
      if (event.controlCutoff === undefined) {
        this.navigationAbort?.abort()
        this.regions.clear()
      } else this.regions.clearThrough(event.controlCutoff)
      this.cancelRemovedCandidates()
      this.updateTelemetry()
      this.publish()
      return undefined
    }
    if (event.type !== 'semantic') return undefined
    const changed = this.regions.consume(event)
    this.cancelRemovedCandidates()
    this.updateTelemetry()
    if (changed) this.publish()
    return undefined
  }

  async navigate(
    direction: TerminalSemanticRegionDirection,
    pane: TerminalRuntimePane,
  ): Promise<void> {
    this.navigationAbort?.abort()
    const controller = new AbortController()
    this.navigationAbort = controller
    this.navigationCandidate = undefined
    const capability =
      pane.retained ??
      (!isNativeTerminalPane(pane) ? legacyTerminalRetainedQuery(pane) : undefined)
    if (!capability) return
    try {
      const screen = await capability.activeScreen(controller.signal)
      controller.signal.throwIfAborted()
      const candidates = this.regions.navigationCandidateIds(direction, screen)
      const before = this.regions.size
      const summary = await this.regions.navigateCandidates(
        candidates,
        screen,
        (boundary) => capability.resolveBoundary(boundary, controller.signal),
        (boundary) => capability.revealBoundary(boundary, controller.signal),
        controller.signal,
        (id) => {
          this.navigationCandidate = id
        },
      )
      if (!controller.signal.aborted) {
        this.updateTelemetry()
        if (summary || this.regions.size !== before) this.publish(summary)
      }
    } catch {
      // Revoked/evicted occurrences do not change terminal input availability.
    } finally {
      if (this.navigationAbort === controller) {
        this.navigationAbort = undefined
        this.navigationCandidate = undefined
      }
    }
  }

  async extractCurrentRegion(
    pane: TerminalRuntimePane,
    signal: AbortSignal,
  ): Promise<string> {
    const capability =
      pane.retained ??
      (!isNativeTerminalPane(pane) ? legacyTerminalRetainedQuery(pane) : undefined)
    if (!capability) throw new Error('Terminal retained queries are unavailable')
    const screen = await capability.activeScreen(signal)
    const range = this.regions.currentCopyRange(screen)
    if (!range) throw new Error('No semantic terminal region is available')
    const end = range.end
    if (signal.aborted) throw new Error('The current terminal region is unavailable')
    return capability.readRange(range.start, end, signal)
  }

  clear(): void {
    this.navigationAbort?.abort()
    this.navigationAbort = undefined
    this.navigationCandidate = undefined
    this.regions.clear()
    this.currentTitle = this.fallbackTitle
    this.updateTelemetry()
    this.publish()
  }

  private cancelRemovedCandidates(): void {
    if (
      this.navigationCandidate !== undefined &&
      !this.regions.boundary(this.navigationCandidate)
    )
      this.navigationAbort?.abort()
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
