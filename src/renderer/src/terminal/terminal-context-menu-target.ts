import type { Disposer } from '../../../shared'
import type { TerminalPane } from './terminal-pane'

/** Revocable access to one exact live terminal pane for its host-owned menu. */
export interface TerminalContextMenuTarget {
  readonly sessionId: string
  isCurrent(): boolean
  hasSelection(): boolean
  getSelection(): string | undefined
  paste(data: string): boolean
  selectAll(): boolean
  clear(): boolean
  reset(): boolean
  focus(): boolean
  onRevoked(callback: () => void): Disposer
}

function createTerminalContextMenuTarget(options: {
  readonly sessionId: string
  readonly pane: TerminalPane
  readonly isCurrent: () => boolean
  readonly focusOwner: () => void
  readonly subscribe: (callback: () => void) => Disposer
}): TerminalContextMenuTarget {
  const act = (action: (pane: TerminalPane) => void): boolean => {
    if (!options.isCurrent()) return false
    action(options.pane)
    return true
  }
  return {
    sessionId: options.sessionId,
    isCurrent: options.isCurrent,
    hasSelection: () => options.isCurrent() && options.pane.hasSelection(),
    getSelection: () => (options.isCurrent() ? options.pane.getSelection() : undefined),
    paste: (data) => act((pane) => pane.paste(data)),
    selectAll: () => act((pane) => pane.selectAll()),
    clear: () => act((pane) => pane.clear()),
    reset: () => act((pane) => pane.reset()),
    focus: () =>
      act((pane) => {
        pane.focus()
        options.focusOwner()
      }),
    onRevoked: (callback) =>
      options.subscribe(() => {
        if (!options.isCurrent()) callback()
      }),
  }
}

/** Owns and revokes menu authority independently from a pane's retained presentation. */
export class TerminalContextMenuOwner {
  private pane?: TerminalPane
  private sessionId?: string
  private ptyId?: string
  private focusOwner: () => void = () => undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly available: () => boolean) {}

  readonly target = (): TerminalContextMenuTarget | undefined => {
    const pane = this.pane
    const sessionId = this.sessionId
    const ptyId = this.ptyId
    if (!pane || !sessionId || !ptyId || !this.owns(pane, ptyId)) return undefined
    return createTerminalContextMenuTarget({
      sessionId,
      pane,
      isCurrent: () => this.owns(pane, ptyId),
      focusOwner: () => this.focusOwner(),
      subscribe: (callback) => {
        this.listeners.add(callback)
        return () => {
          this.listeners.delete(callback)
        }
      },
    })
  }

  bind(
    sessionId: string,
    pane: TerminalPane,
    ptyId: string,
    focusOwner: () => void,
  ): void {
    this.sessionId = sessionId
    this.pane = pane
    this.ptyId = ptyId
    this.focusOwner = focusOwner
    this.notify()
  }

  revoke(): void {
    if (!this.pane && !this.ptyId) return
    this.pane = undefined
    this.sessionId = undefined
    this.ptyId = undefined
    this.focusOwner = () => undefined
    this.notify()
  }

  private owns(pane: TerminalPane, ptyId: string): boolean {
    return this.pane === pane && this.ptyId === ptyId && this.available()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
