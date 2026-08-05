import type { Disposer } from '../../../shared'
import type { TerminalPane } from './terminal-pane'

/** Revocable access to one exact live terminal pane for its host-owned menu. */
export interface TerminalContextMenuTarget {
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
  readonly pane: TerminalPane
  readonly isCurrent: () => boolean
  readonly focusOwner: () => void
  readonly clearOwner: () => void
  readonly resetOwner: () => void
  readonly subscribe: (callback: () => void) => Disposer
}): TerminalContextMenuTarget {
  const act = (action: (pane: TerminalPane) => void): boolean => {
    if (!options.isCurrent()) return false
    action(options.pane)
    return true
  }
  return {
    isCurrent: options.isCurrent,
    hasSelection: () => options.isCurrent() && options.pane.hasSelection(),
    getSelection: () => (options.isCurrent() ? options.pane.getSelection() : undefined),
    paste: (data) => act((pane) => pane.paste(data)),
    selectAll: () => act((pane) => pane.selectAll()),
    clear: () =>
      act((pane) => {
        options.clearOwner()
        pane.clear()
      }),
    reset: () =>
      act((pane) => {
        options.resetOwner()
        pane.reset()
      }),
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
  private ptyId?: string
  private focusOwner: () => void = () => undefined
  private clearOwner: () => void = () => undefined
  private resetOwner: () => void = () => undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly available: () => boolean) {}

  readonly target = (): TerminalContextMenuTarget | undefined => {
    const pane = this.pane
    const ptyId = this.ptyId
    if (!pane || !ptyId || !this.owns(pane, ptyId)) return undefined
    return createTerminalContextMenuTarget({
      pane,
      isCurrent: () => this.owns(pane, ptyId),
      focusOwner: () => this.focusOwner(),
      clearOwner: () => this.clearOwner(),
      resetOwner: () => this.resetOwner(),
      subscribe: (callback) => {
        this.listeners.add(callback)
        return () => {
          this.listeners.delete(callback)
        }
      },
    })
  }

  bind(
    pane: TerminalPane,
    ptyId: string,
    focusOwner: () => void,
    owners: Readonly<{ clear: () => void; reset: () => void }> = {
      clear: () => undefined,
      reset: () => undefined,
    },
  ): void {
    this.pane = pane
    this.ptyId = ptyId
    this.focusOwner = focusOwner
    this.clearOwner = owners.clear
    this.resetOwner = owners.reset
    this.notify()
  }

  revoke(): void {
    if (!this.pane && !this.ptyId) return
    this.pane = undefined
    this.ptyId = undefined
    this.focusOwner = () => undefined
    this.clearOwner = () => undefined
    this.resetOwner = () => undefined
    this.notify()
  }

  private owns(pane: TerminalPane, ptyId: string): boolean {
    return this.pane === pane && this.ptyId === ptyId && this.available()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
