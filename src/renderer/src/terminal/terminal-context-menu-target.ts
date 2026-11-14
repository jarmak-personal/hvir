import type { Disposer } from '../../../shared'
import type {
  TerminalPane,
  NativeTerminalPanePort,
  TerminalSelectionCapability,
} from './terminal-pane'
type MenuPane = TerminalPane | NativeTerminalPanePort

/** Revocable access to one exact live terminal pane for its host-owned menu. */
export interface TerminalContextMenuTarget {
  isCurrent(): boolean
  hasSelection(signal?: AbortSignal): Promise<boolean>
  getSelection(signal?: AbortSignal): Promise<string | undefined>
  paste(data: string): boolean
  selectAll(signal?: AbortSignal): Promise<boolean>
  clear(signal?: AbortSignal): Promise<boolean>
  reset(signal?: AbortSignal): Promise<boolean>
  focus(): boolean
  onRevoked(callback: () => void): Disposer
}

function createTerminalContextMenuTarget(options: {
  readonly pane: MenuPane
  readonly isCurrent: () => boolean
  readonly focusOwner: () => void
  readonly clearOwner: () => void
  readonly resetOwner: () => void
  readonly subscribe: (callback: () => void) => Disposer
}): TerminalContextMenuTarget {
  const selection: TerminalSelectionCapability = options.pane.selection ?? {
    status: () =>
      Promise.resolve({ hasSelection: (options.pane as TerminalPane).hasSelection() }),
    read: () => Promise.resolve((options.pane as TerminalPane).getSelection()),
    selectAll: () => {
      ;(options.pane as TerminalPane).selectAll()
      return Promise.resolve()
    },
    clear: () => {
      ;(options.pane as TerminalPane).clear()
      return Promise.resolve()
    },
    reset: () => {
      ;(options.pane as TerminalPane).reset()
      return Promise.resolve()
    },
  }
  const capability = options.pane.selection
  const current = () =>
    options.isCurrent() && (!capability || options.pane.selection === capability)
  const act = (action: (pane: MenuPane) => void): boolean => {
    if (!current()) return false
    action(options.pane)
    return true
  }
  const selectionAction = async (
    action: 'selectAll' | 'clear' | 'reset',
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (!current()) return false
    await selection[action](signal)
    if (!current()) return false
    if (action === 'clear') options.clearOwner()
    if (action === 'reset') options.resetOwner()
    return true
  }
  return {
    isCurrent: current,
    hasSelection: async (signal) =>
      current() && (await selection.status(signal)).hasSelection && current(),
    getSelection: async (signal) => {
      if (!current()) return undefined
      const text = await selection.read(signal)
      return current() ? text : undefined
    },
    paste: (data) => act((pane) => pane.paste(data)),
    selectAll: (signal) => selectionAction('selectAll', signal),
    clear: (signal) => selectionAction('clear', signal),
    reset: (signal) => selectionAction('reset', signal),
    focus: () =>
      act((pane) => {
        pane.focus()
        options.focusOwner()
      }),
    onRevoked: (callback) =>
      options.subscribe(() => {
        if (!current()) callback()
      }),
  }
}

/** Owns and revokes menu authority independently from a pane's retained presentation. */
export class TerminalContextMenuOwner {
  private pane?: MenuPane
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
    pane: MenuPane,
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

  private owns(pane: MenuPane, ptyId: string): boolean {
    return this.pane === pane && this.ptyId === ptyId && this.available()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
