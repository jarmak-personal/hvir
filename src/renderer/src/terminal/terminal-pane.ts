/**
 * `TerminalPane` — the terminal seam (ADR-003).
 *
 * The terminal is a swappable pane, never the foundation. Everything above this
 * interface is engine-agnostic; the concrete implementation (ghostty-web, then
 * native libghostty) lands in Phase 2. Because ghostty-web is xterm.js-API
 * compatible, this shape stays close to that mental model.
 *
 * Concrete engines implement this interface; the Phase 2 spike uses
 * ghostty-web in `ghostty-terminal-pane.ts`.
 */

import type { Disposer } from '../../../shared'

export interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

export interface TerminalColorTheme {
  readonly background: string
  readonly foreground: string
  readonly cursor: string
  readonly selectionBackground: string
  readonly black: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly blue: string
  readonly magenta: string
  readonly cyan: string
  readonly white: string
}

export interface TerminalTypography {
  readonly fontFamily: string
  readonly fontSize: number
}

export type TerminalPresentation = 'visible' | 'hidden'

export type TerminalEventScreen = 'normal' | 'alternate'

export interface TerminalEventProvenance {
  readonly id: number
  readonly screen: TerminalEventScreen
  readonly row: number
}

export interface TerminalEventLocation {
  readonly screen: TerminalEventScreen
  readonly row: number
}

export type TerminalSemanticAction =
  | 'fresh-line'
  | 'fresh-line-new-prompt'
  | 'new-command'
  | 'prompt-start'
  | 'end-prompt-start-input'
  | 'end-prompt-start-input-terminate-eol'
  | 'end-input-start-output'
  | 'end-command'

export type TerminalProgressState = 'remove' | 'set' | 'error' | 'indeterminate' | 'pause'

export type TerminalPaletteTarget =
  | { readonly kind: 'palette'; readonly index: number }
  | {
      readonly kind: 'special'
      readonly name: 'bold' | 'underline' | 'blink' | 'reverse' | 'italic'
    }
  | {
      readonly kind: 'dynamic'
      readonly name:
        | 'foreground'
        | 'background'
        | 'cursor'
        | 'pointer-foreground'
        | 'pointer-background'
        | 'tektronix-foreground'
        | 'tektronix-background'
        | 'highlight-background'
        | 'tektronix-cursor'
        | 'highlight-foreground'
    }

export interface TerminalEventColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

export type TerminalPaletteRequest =
  | {
      readonly type: 'set'
      readonly target: TerminalPaletteTarget
      readonly color: TerminalEventColor
    }
  | { readonly type: 'query'; readonly target: TerminalPaletteTarget }
  | { readonly type: 'reset'; readonly target: TerminalPaletteTarget }
  | { readonly type: 'reset-palette' }
  | { readonly type: 'reset-special' }

/** Closed, engine-neutral events produced by the terminal parser/state owner. */
export type TerminalEvent =
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'working-directory'; readonly uri: string }
  | { readonly type: 'bell' }
  | {
      readonly type: 'notification'
      readonly title: string
      readonly body: string
    }
  | {
      readonly type: 'progress'
      readonly state: TerminalProgressState
      readonly progress?: number
    }
  | {
      readonly type: 'semantic'
      readonly action: TerminalSemanticAction
      readonly options: string
      readonly provenance: TerminalEventProvenance
    }
  | {
      readonly type: 'palette'
      readonly operation: number
      readonly request: TerminalPaletteRequest
    }
  | {
      readonly type: 'clipboard'
      readonly operation: 'read'
      readonly selection: string
    }
  | {
      readonly type: 'clipboard'
      readonly operation: 'write'
      readonly selection: string
      readonly data: string
    }

export type TerminalLinkActivation =
  | { readonly kind: 'file'; readonly target: string }
  | { readonly kind: 'loopback-http'; readonly target: string }

export interface TerminalPaneEvents {
  /** User keystrokes / paste — data the pane wants written to the PTY. */
  onData(cb: (data: string) => void): Disposer
  /** Explicit clipboard-paste gesture; policy remains outside the swappable pane. */
  onClipboardPaste(cb: (fallbackData: string) => void): Disposer
  /** Parser-owned terminal semantics; consumers retain all product authority. */
  onEvent(cb: (event: TerminalEvent) => void): Disposer
  /** The pane's own resize (cols/rows), e.g. from a layout change. */
  onResize(cb: (size: TerminalSize) => void): Disposer
  /** A user explicitly activated a typed link rendered by the terminal. */
  onLink(cb: (activation: TerminalLinkActivation) => void): Disposer
}

export interface TerminalPane {
  /** Attach the pane to a DOM container and begin rendering. */
  mount(container: HTMLElement): void
  /** Move the retained render surface without resetting its VT buffer. */
  reparent(container: HTMLElement): void
  /** Tear down, releasing the render surface and all listeners. */
  dispose(): void
  /** Write PTY output into the pane. */
  write(data: string): void
  /** Resize the terminal grid. */
  resize(cols: number, rows: number): void
  /** Update colors without remounting or restarting the PTY. */
  setTheme(theme: TerminalColorTheme): void
  /** Update local text presentation, refit the grid, and retain the VT buffer. */
  setTypography(typography: TerminalTypography): void
  /** Start or stop visible engine work without changing the live terminal state. */
  setPresentation(presentation: TerminalPresentation): void
  /** Force the current grid to repaint without changing PTY geometry. */
  redraw(): void
  /** Resolve retained semantic provenance, or fail closed after eviction/reset. */
  resolveEventProvenance(
    provenance: TerminalEventProvenance,
  ): TerminalEventLocation | undefined
  focus(): void
  readonly events: TerminalPaneEvents
}
