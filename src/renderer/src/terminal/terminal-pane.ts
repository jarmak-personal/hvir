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

export interface OscEvent {
  readonly code: number
  readonly data: string
}

export interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

export interface TerminalPaneEvents {
  /** User keystrokes / paste — data the pane wants written to the PTY. */
  onData(cb: (data: string) => void): Disposer
  /** OSC 0/2 title change (drives auto-titled terminals — §7). */
  onTitle(cb: (title: string) => void): Disposer
  /** BEL / OSC 9 (a notification signal — ADR-009). */
  onBell(cb: () => void): Disposer
  /** Any other OSC sequence, for adapters that need it. */
  onOsc(cb: (osc: OscEvent) => void): Disposer
  /** The pane's own resize (cols/rows), e.g. from a layout change. */
  onResize(cb: (size: TerminalSize) => void): Disposer
  /** A user activated an inert link target rendered by the terminal. */
  onLink(cb: (target: string) => void): Disposer
}

export interface TerminalPane {
  /** Attach the pane to a DOM container and begin rendering. */
  mount(container: HTMLElement): void
  /** Tear down, releasing the render surface and all listeners. */
  dispose(): void
  /** Write PTY output into the pane. */
  write(data: string): void
  /** Resize the terminal grid. */
  resize(cols: number, rows: number): void
  /** Force the current grid to repaint without changing PTY geometry. */
  redraw(): void
  focus(): void
  readonly events: TerminalPaneEvents
}
