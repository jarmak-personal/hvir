import type {
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalSemanticAction,
  TerminalSubmittedInputDecoration,
} from './terminal-pane'

export const MAX_TERMINAL_SEMANTIC_REGIONS = 256

export type TerminalSemanticRegionKind = 'prompt' | 'command' | 'output'
export type TerminalSemanticRegionDirection = 'previous' | 'next'

export interface TerminalSemanticRegionSummary {
  readonly kind: TerminalSemanticRegionKind
  readonly index: number
  readonly total: number
}

export interface TerminalSemanticMarker {
  readonly action: TerminalSemanticAction
  readonly provenance: TerminalEventProvenance
}

export interface ResolvedTerminalSemanticRegion {
  readonly id: number
  readonly kind: TerminalSemanticRegionKind
  readonly location: TerminalEventLocation
}

export interface TerminalSemanticNavigationPlan {
  readonly candidates: readonly ResolvedTerminalSemanticRegion[]
  readonly resolved: readonly ResolvedTerminalSemanticRegion[]
  readonly changed: boolean
}

export interface TerminalSemanticCopyRange {
  readonly kind: TerminalSemanticRegionKind
  readonly start: TerminalEventProvenance
  readonly end?: TerminalEventProvenance
}

interface SemanticRegion {
  readonly id: number
  readonly kind: TerminalSemanticRegionKind
  readonly screen: TerminalEventScreen
  readonly start: TerminalEventProvenance
  end?: TerminalEventProvenance
}

interface MarkerSignature {
  readonly action: TerminalSemanticAction
  readonly row: number
  readonly column: number
}

/**
 * Per-pane semantic transcript state. It stores terminal-owned provenance only;
 * transcript text and provider policy never enter this owner.
 */
export class TerminalSemanticRegions {
  private regions: SemanticRegion[] = []
  private readonly openByScreen = new Map<TerminalEventScreen, number>()
  private readonly lastMarkerByScreen = new Map<TerminalEventScreen, MarkerSignature>()
  private nextId = 1
  private activeId?: number

  get size(): number {
    return this.regions.length
  }

  completedCommandDecorations(): readonly TerminalSubmittedInputDecoration[] {
    return this.regions.flatMap((region) =>
      region.kind === 'command' && region.end
        ? [{ id: region.id, start: region.start, end: region.end }]
        : [],
    )
  }

  consume(marker: TerminalSemanticMarker): boolean {
    const beforeAvailable = this.regions.length > 0
    const beforeActive = this.activeId
    const { action, provenance } = marker
    if (action === 'fresh-line') return false

    const last = this.lastMarkerByScreen.get(provenance.screen)
    if (
      last?.action === action &&
      last.row === provenance.row &&
      last.column === provenance.column
    ) {
      return false
    }
    this.lastMarkerByScreen.set(provenance.screen, {
      action,
      row: provenance.row,
      column: provenance.column,
    })

    switch (action) {
      case 'fresh-line-new-prompt':
      case 'new-command':
        this.startPrompt(provenance)
        break
      case 'prompt-start':
        this.startPrompt(provenance)
        break
      case 'end-prompt-start-input':
      case 'end-prompt-start-input-terminate-eol':
        if (!this.transition(provenance, 'prompt', 'command')) {
          this.dropOpen(provenance.screen)
        }
        break
      case 'end-input-start-output':
        if (!this.transition(provenance, 'command', 'output')) {
          this.dropOpen(provenance.screen)
        }
        break
      case 'end-command':
        if (!this.finish(provenance, 'output')) this.dropOpen(provenance.screen)
        break
    }

    this.enforceBound()
    return beforeAvailable !== this.regions.length > 0 || beforeActive !== this.activeId
  }

  navigationPlan(
    direction: TerminalSemanticRegionDirection,
    screen: TerminalEventScreen,
    resolve: (provenance: TerminalEventProvenance) => TerminalEventLocation | undefined,
  ): TerminalSemanticNavigationPlan {
    const retained: SemanticRegion[] = []
    const resolved: ResolvedTerminalSemanticRegion[] = []
    for (const region of this.regions) {
      const location = resolve(region.start)
      const end = region.end ? resolve(region.end) : location
      if (!location || !end || location.screen !== end.screen) {
        if (this.openByScreen.get(region.screen) === region.id) {
          this.openByScreen.delete(region.screen)
        }
        continue
      }
      retained.push(region)
      resolved.push({ id: region.id, kind: region.kind, location })
    }

    const changed = retained.length !== this.regions.length
    this.regions = retained
    if (this.activeId !== undefined && !retained.some(({ id }) => id === this.activeId)) {
      this.activeId = undefined
    }
    for (const candidateScreen of ['normal', 'alternate'] as const) {
      if (!retained.some((region) => region.screen === candidateScreen)) {
        this.lastMarkerByScreen.delete(candidateScreen)
      }
    }

    const visible = resolved.filter(({ location }) => location.screen === screen)
    const activeIndex = visible.findIndex(({ id }) => id === this.activeId)
    const candidates =
      activeIndex < 0
        ? direction === 'previous'
          ? [...visible].reverse()
          : visible
        : direction === 'previous'
          ? visible.slice(0, activeIndex).reverse()
          : visible.slice(activeIndex + 1)

    return { candidates, resolved, changed }
  }

  activate(
    id: number,
    screen: TerminalEventScreen,
    resolved: readonly ResolvedTerminalSemanticRegion[],
  ): TerminalSemanticRegionSummary | undefined {
    const visible = resolved.filter(({ location }) => location.screen === screen)
    const index = visible.findIndex((region) => region.id === id)
    if (index < 0) return undefined
    this.activeId = id
    return {
      kind: visible[index]!.kind,
      index: index + 1,
      total: visible.length,
    }
  }

  currentCopyRange(screen: TerminalEventScreen): TerminalSemanticCopyRange | undefined {
    const active =
      this.activeId === undefined
        ? undefined
        : this.regions.find(
            (region) => region.id === this.activeId && region.screen === screen,
          )
    const region =
      active ??
      [...this.regions].reverse().find((candidate) => candidate.screen === screen)
    return region
      ? { kind: region.kind, start: region.start, end: region.end }
      : undefined
  }

  clear(): void {
    this.regions = []
    this.openByScreen.clear()
    this.lastMarkerByScreen.clear()
    this.activeId = undefined
  }

  private startPrompt(provenance: TerminalEventProvenance): void {
    const open = this.open(provenance.screen)
    if (
      open?.kind === 'prompt' &&
      open.start.row === provenance.row &&
      open.start.column === provenance.column
    ) {
      return
    }
    if (open) {
      if (open.kind === 'output') {
        this.complete(open, provenance)
      } else {
        this.dropOpen(provenance.screen)
      }
    }
    this.start('prompt', provenance)
  }

  private transition(
    provenance: TerminalEventProvenance,
    expected: TerminalSemanticRegionKind,
    next: TerminalSemanticRegionKind,
  ): boolean {
    const open = this.open(provenance.screen)
    if (open?.kind !== expected) return false
    this.complete(open, provenance)
    this.start(next, provenance)
    return true
  }

  private finish(
    provenance: TerminalEventProvenance,
    expected: TerminalSemanticRegionKind,
  ): boolean {
    const open = this.open(provenance.screen)
    if (open?.kind !== expected) return false
    this.complete(open, provenance)
    return true
  }

  private start(kind: TerminalSemanticRegionKind, start: TerminalEventProvenance): void {
    const region: SemanticRegion = {
      id: this.nextId++,
      kind,
      screen: start.screen,
      start,
    }
    this.regions.push(region)
    this.openByScreen.set(start.screen, region.id)
  }

  private complete(region: SemanticRegion, end: TerminalEventProvenance): void {
    region.end = end
    this.openByScreen.delete(region.screen)
  }

  private dropOpen(screen: TerminalEventScreen): void {
    const id = this.openByScreen.get(screen)
    if (id === undefined) return
    this.openByScreen.delete(screen)
    this.regions = this.regions.filter((region) => region.id !== id)
    if (this.activeId === id) this.activeId = undefined
  }

  private open(screen: TerminalEventScreen): SemanticRegion | undefined {
    const id = this.openByScreen.get(screen)
    return id === undefined ? undefined : this.regions.find((region) => region.id === id)
  }

  private enforceBound(): void {
    while (this.regions.length > MAX_TERMINAL_SEMANTIC_REGIONS) {
      const removed = this.regions.shift()
      if (!removed) break
      if (this.openByScreen.get(removed.screen) === removed.id) {
        this.openByScreen.delete(removed.screen)
      }
      if (this.activeId === removed.id) this.activeId = undefined
    }
  }
}
