import type { Terminal as GhosttyTerminal } from 'ghostty-web'

import type {
  TerminalColorTheme,
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalPresentation,
  TerminalSubmittedInputDecoration,
} from './terminal-pane'

/** Owns Ghostty geometry and visible DOM for completed submitted-input ranges. */
export class GhosttySubmittedInputDecorations {
  private decorations: readonly TerminalSubmittedInputDecoration[] = []
  private layer?: HTMLDivElement
  private paints = 0
  private presentation: TerminalPresentation = 'visible'

  constructor(
    private readonly terminal: GhosttyTerminal,
    private theme: TerminalColorTheme,
    private readonly resolve: (
      provenance: TerminalEventProvenance,
    ) => TerminalEventLocation | undefined,
    private readonly activeScreen: () => TerminalEventScreen,
  ) {}

  get stats(): Readonly<{
    decorations: number
    segments: number
    paints: number
  }> {
    return {
      decorations: this.decorations.length,
      segments: this.layer?.childElementCount ?? 0,
      paints: this.paints,
    }
  }

  mount(surface: HTMLElement): void {
    const layer = document.createElement('div')
    layer.className = 'terminal-submitted-input-decoration-layer'
    layer.setAttribute('aria-hidden', 'true')
    surface.append(layer)
    this.layer = layer
    this.applyTheme()
  }

  setTheme(theme: TerminalColorTheme): void {
    this.theme = theme
    this.applyTheme()
  }

  setPresentation(presentation: TerminalPresentation): void {
    this.presentation = presentation
    if (presentation === 'hidden') this.releasePaint()
    else this.render()
  }

  setDecorations(decorations: readonly TerminalSubmittedInputDecoration[]): void {
    this.decorations = [...decorations]
    this.render()
  }

  clear(): void {
    this.decorations = []
    this.releasePaint()
  }

  render(): void {
    if (this.presentation === 'hidden') return
    const layer = this.layer
    const renderer = this.terminal.renderer
    if (!layer || !renderer) return
    const metrics = renderer.getMetrics()
    if (metrics.width <= 0 || metrics.height <= 0) return
    const screen = this.activeScreen()
    const retained: TerminalSubmittedInputDecoration[] = []
    const resolved: Array<
      Readonly<{
        decoration: TerminalSubmittedInputDecoration
        start: TerminalEventLocation
        end: TerminalEventLocation
      }>
    > = []
    for (const decoration of this.decorations) {
      const start = this.resolve(decoration.start)
      const end = this.resolve(decoration.end)
      if (!start || !end || start.screen !== end.screen) continue
      if (end.row < start.row || (end.row === start.row && end.column <= start.column)) {
        continue
      }
      retained.push(decoration)
      if (start.screen === screen) resolved.push({ decoration, start, end })
    }
    this.decorations = retained

    const scrollbackLength = this.terminal.getScrollbackLength()
    const viewportY = Math.max(0, Math.floor(this.terminal.getViewportY()))
    const firstVisibleRow = scrollbackLength - viewportY
    const lastVisibleRow = firstVisibleRow + this.terminal.rows - 1
    const canvas = renderer.getCanvas()
    const cols = this.terminal.cols
    const segments: HTMLDivElement[] = []
    if (cols > 0) {
      for (const { decoration, start, end } of resolved) {
        const firstRow = Math.max(start.row, firstVisibleRow)
        const lastRow = Math.min(end.row, lastVisibleRow)
        for (let row = firstRow; row <= lastRow; row += 1) {
          const startColumn = row === start.row ? start.column : 0
          const endColumn = row === end.row ? end.column : cols
          const boundedStart = Math.max(0, Math.min(cols, startColumn))
          const boundedEnd = Math.max(0, Math.min(cols, endColumn))
          if (boundedEnd <= boundedStart) continue
          const segment = document.createElement('div')
          segment.className = 'terminal-submitted-input-decoration'
          segment.dataset.decorationId = String(decoration.id)
          segment.dataset.retainedRow = String(row)
          segment.style.left = `${canvas.offsetLeft + boundedStart * metrics.width}px`
          segment.style.top = `${
            canvas.offsetTop + (row - firstVisibleRow) * metrics.height
          }px`
          segment.style.width = `${(boundedEnd - boundedStart) * metrics.width}px`
          segment.style.height = `${metrics.height}px`
          segments.push(segment)
        }
      }
    }
    layer.replaceChildren(...segments)
    this.paints += 1
  }

  dispose(): void {
    this.decorations = []
    this.layer?.remove()
    this.layer = undefined
  }

  private applyTheme(): void {
    if (!this.layer) return
    this.layer.style.setProperty('--terminal-input-background', this.theme.background)
    this.layer.style.setProperty('--terminal-input-foreground', this.theme.foreground)
  }

  private releasePaint(): void {
    this.layer?.replaceChildren()
  }
}
