import type {
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalSemanticAction,
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
  readonly provenanceId: number
  readonly boundaryId?: string
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

  consume(marker: TerminalSemanticMarker): boolean {
    const beforeAvailable = this.regions.length > 0
    const beforeActive = this.activeId
    const { action, provenance } = marker
    if (action === 'fresh-line') return false

    const last = this.lastMarkerByScreen.get(provenance.screen)
    if (
      last?.action === action &&
      last.row === provenance.row &&
      last.column === provenance.column &&
      last.boundaryId === provenance.boundaryId
    ) {
      return false
    }
    this.lastMarkerByScreen.set(provenance.screen, {
      provenanceId: provenance.id,
      action,
      boundaryId: provenance.boundaryId,
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

  navigationCandidateIds(
    direction: TerminalSemanticRegionDirection,
    screen: TerminalEventScreen,
  ): readonly number[] {
    const visible = this.regions.filter((region) => region.screen === screen)
    return (direction === 'previous' ? visible.reverse() : visible).map(({ id }) => id)
  }

  async navigateCandidates(
    candidates: readonly number[],
    screen: TerminalEventScreen,
    resolve: (
      boundary: TerminalEventProvenance,
    ) => Promise<TerminalEventLocation | undefined>,
    reveal: (boundary: TerminalEventProvenance) => Promise<boolean>,
    signal: AbortSignal,
    attempting?: (id: number) => void,
  ): Promise<TerminalSemanticRegionSummary | undefined> {
    const active = this.regions.find(
      (region) => region.id === this.activeId && region.screen === screen,
    )
    let offset = 0
    if (active && candidates.includes(active.id)) {
      attempting?.(active.id)
      if (await this.resolveCandidate(active, screen, resolve, signal))
        offset = candidates.indexOf(active.id) + 1
    }
    for (const id of candidates.slice(offset)) {
      signal.throwIfAborted()
      const region = this.regions.find((candidate) => candidate.id === id)
      if (!region || region.screen !== screen) continue
      attempting?.(id)
      if (!(await this.resolveCandidate(region, screen, resolve, signal))) continue
      if (!(await reveal(region.start))) continue
      signal.throwIfAborted()
      if (!this.regions.includes(region)) continue
      const visible = this.regions.filter((candidate) => candidate.screen === screen)
      const index = visible.findIndex((candidate) => candidate.id === id)
      this.activeId = id
      return { kind: region.kind, index: index + 1, total: visible.length }
    }
    return undefined
  }

  private async resolveCandidate(
    region: SemanticRegion,
    screen: TerminalEventScreen,
    resolve: (
      boundary: TerminalEventProvenance,
    ) => Promise<TerminalEventLocation | undefined>,
    signal: AbortSignal,
  ): Promise<TerminalEventLocation | undefined> {
    signal.throwIfAborted()
    const location = await resolve(region.start)
    signal.throwIfAborted()
    if (!this.regions.includes(region)) return undefined
    if (!location || location.screen !== screen) {
      this.removeRegion(region.id)
      return undefined
    }
    const end =
      region.end && region.end !== region.start ? await resolve(region.end) : location
    signal.throwIfAborted()
    if (!this.regions.includes(region)) return undefined
    if (!end || end.screen !== screen) {
      this.removeRegion(region.id)
      return undefined
    }
    return location
  }

  boundary(id: number): TerminalEventProvenance | undefined {
    return this.regions.find((region) => region.id === id)?.start
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

  /** Native control cutoffs are parser serials; they do not erase later prompts. */
  clearThrough(cutoff: number): void {
    this.regions = this.regions.filter((region) => region.start.id > cutoff)
    for (const [screen, id] of this.openByScreen)
      if (!this.regions.some((region) => region.id === id))
        this.openByScreen.delete(screen)
    for (const [screen, marker] of this.lastMarkerByScreen)
      if (marker.provenanceId <= cutoff) this.lastMarkerByScreen.delete(screen)
    if (
      this.activeId !== undefined &&
      !this.regions.some((region) => region.id === this.activeId)
    )
      this.activeId = undefined
  }

  private removeRegion(id: number): void {
    const region = this.regions.find((candidate) => candidate.id === id)
    if (!region) return
    this.regions = this.regions.filter((candidate) => candidate.id !== id)
    if (this.openByScreen.get(region.screen) === id)
      this.openByScreen.delete(region.screen)
    if (this.activeId === id) this.activeId = undefined
    if (!this.regions.some((candidate) => candidate.screen === region.screen))
      this.lastMarkerByScreen.delete(region.screen)
  }

  private startPrompt(provenance: TerminalEventProvenance): void {
    const open = this.open(provenance.screen)
    if (
      open?.kind === 'prompt' &&
      open.start.row === provenance.row &&
      open.start.column === provenance.column &&
      open.start.boundaryId === provenance.boundaryId
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
