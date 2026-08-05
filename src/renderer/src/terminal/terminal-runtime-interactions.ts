import { TerminalContextMenuOwner } from './terminal-context-menu-target'
import type { TerminalPane } from './terminal-pane'
import { TerminalPaneEventCoordinator } from './terminal-pane-event-coordinator'
import { TerminalSearchController } from './terminal-search-controller'
import type { TerminalSemanticRegionDirection } from './terminal-semantic-regions'

/** Owns revocable, selected-pane transcript and menu interactions for one runtime. */
export class TerminalRuntimeInteractions {
  readonly paneEvents: TerminalPaneEventCoordinator
  readonly search: TerminalSearchController
  private selected = false
  private pane?: TerminalPane
  private readonly contextMenu: TerminalContextMenuOwner

  constructor(
    fallbackTitle: string,
    private readonly canFocus: () => boolean,
    restoreFocus: () => void,
    private readonly focusOwner: () => void,
  ) {
    this.paneEvents = new TerminalPaneEventCoordinator(fallbackTitle)
    this.search = new TerminalSearchController(restoreFocus, (pane, signal) =>
      this.paneEvents.extractCurrentRegion(pane, signal),
    )
    this.search.setAvailable(false)
    this.contextMenu = new TerminalContextMenuOwner(
      () => this.selected && this.canFocus(),
    )
  }

  readonly contextMenuTarget = (): ReturnType<TerminalContextMenuOwner['target']> =>
    this.contextMenu.target()

  updateAvailability(selected: boolean): void {
    this.selected = selected
    this.synchronizeAvailability()
  }

  synchronizeAvailability(): void {
    this.search.setAvailable(this.selected && this.canFocus())
  }

  attachSurface(container: HTMLElement): void {
    this.paneEvents.attach(container)
    this.synchronizeAvailability()
  }

  detachSurface(container: HTMLElement): void {
    this.paneEvents.detach(container)
    this.synchronizeAvailability()
  }

  bind(pane: TerminalPane, ptyId: string): void {
    this.pane = pane
    this.search.bind(pane)
    this.synchronizeAvailability()
    this.contextMenu.bind(pane, ptyId, this.focusOwner, {
      clear: () => this.search.close(false),
      reset: () => {
        this.search.close(false)
        this.paneEvents.clear()
      },
    })
  }

  navigate(direction: TerminalSemanticRegionDirection): void {
    if (this.pane && this.selected && this.canFocus()) {
      this.paneEvents.navigate(direction, this.pane)
    }
  }

  retainedBufferChanged(): void {
    this.search.retainedBufferChanged()
  }

  revoke(clearRegions: boolean): void {
    this.search.revoke()
    this.contextMenu.revoke()
    this.pane = undefined
    if (clearRegions) this.paneEvents.clear()
  }
}
