import type { WebPaneCommandAction } from '../../../shared'

export interface WorkbenchCommandPorts {
  readonly closeWebPane: (paneId: string) => void
  readonly escapeWebPaneFocus: () => void
  readonly canUseViewerCommands: () => boolean
  readonly cycleViewMode: () => void
  readonly findFile: () => void
  readonly findInFile: () => void
  readonly findInTerminal: () => boolean
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
  context: 'terminal' | 'web-pane' | 'workbench' = 'workbench',
): boolean {
  switch (action) {
    case 'closeWebPane':
      if (paneId) ports.closeWebPane(paneId)
      return true
    case 'escapeWebPaneFocus':
      ports.escapeWebPaneFocus()
      return true
    case 'cycleViewMode':
      if (ports.canUseViewerCommands()) ports.cycleViewMode()
      return true
    case 'findInFile':
      if (ports.canUseViewerCommands()) ports.findInFile()
      return true
    case 'findInTerminal':
      return context === 'terminal' && ports.findInTerminal()
    case 'findFile':
      ports.findFile()
      return true
    case 'goToLine':
      if (ports.canUseViewerCommands()) ports.goToLine()
      return true
    case 'toggleTerminalFocus':
      ports.toggleTerminalFocus()
      return true
    case 'focusTerminal':
      ports.focusTerminal()
      return true
    case 'focusViewer':
      ports.focusViewer()
      return true
    case 'focusTree':
      ports.focusTree()
      return true
    case 'nextWorkspace':
      ports.switchWorkspace(1)
      return true
    case 'previousWorkspace':
      ports.switchWorkspace(-1)
      return true
  }
}
