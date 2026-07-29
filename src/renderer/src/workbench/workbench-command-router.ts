import type { WebPaneCommandAction } from '../../../shared'

export interface WorkbenchCommandPorts {
  readonly closeWebPane: (paneId: string) => void
  readonly escapeWebPaneFocus: () => void
  readonly canUseViewerCommands: () => boolean
  readonly cycleViewMode: () => void
  readonly findFile: () => void
  readonly findInFile: () => void
  readonly goToLine: () => void
  readonly toggleTerminalFocus: () => void
  readonly focusTerminal: () => void
  readonly focusViewer: () => void
  readonly focusTree: () => void
  readonly switchWorkspace: (direction: -1 | 1) => void
}

export function dispatchWorkbenchCommand(
  action: WebPaneCommandAction,
  paneId: string | undefined,
  ports: WorkbenchCommandPorts,
): void {
  switch (action) {
    case 'closeWebPane':
      if (paneId) ports.closeWebPane(paneId)
      return
    case 'escapeWebPaneFocus':
      ports.escapeWebPaneFocus()
      return
    case 'cycleViewMode':
      if (ports.canUseViewerCommands()) ports.cycleViewMode()
      return
    case 'findInFile':
      if (ports.canUseViewerCommands()) ports.findInFile()
      return
    case 'findFile':
      ports.findFile()
      return
    case 'goToLine':
      if (ports.canUseViewerCommands()) ports.goToLine()
      return
    case 'toggleTerminalFocus':
      ports.toggleTerminalFocus()
      return
    case 'focusTerminal':
      ports.focusTerminal()
      return
    case 'focusViewer':
      ports.focusViewer()
      return
    case 'focusTree':
      ports.focusTree()
      return
    case 'nextWorkspace':
      ports.switchWorkspace(1)
      return
    case 'previousWorkspace':
      ports.switchWorkspace(-1)
  }
}
