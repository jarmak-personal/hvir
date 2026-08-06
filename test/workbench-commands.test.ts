import { describe, expect, it, vi } from 'vitest'

import {
  dispatchWorkbenchCommand,
  type WorkbenchCommandPorts,
} from '../src/renderer/src/workbench/workbench-command-router'

describe('workbench command routing', () => {
  it('routes feature and workspace commands only through explicit ports', () => {
    const ports = commandPorts()
    dispatchWorkbenchCommand('closeWebPane', 'pane-1', ports)
    dispatchWorkbenchCommand('focusTree', undefined, ports)
    dispatchWorkbenchCommand('findFile', undefined, ports)
    dispatchWorkbenchCommand('findInFile', undefined, ports)
    dispatchWorkbenchCommand('goToLine', undefined, ports)
    dispatchWorkbenchCommand('nextWorkspace', undefined, ports)
    dispatchWorkbenchCommand('previousWorkspace', undefined, ports)

    expect(ports.closeWebPane).toHaveBeenCalledWith('pane-1')
    expect(ports.focusTree).toHaveBeenCalledOnce()
    expect(ports.findFile).toHaveBeenCalledOnce()
    expect(ports.findInFile).toHaveBeenCalledOnce()
    expect(ports.goToLine).toHaveBeenCalledOnce()
    expect(ports.switchWorkspace).toHaveBeenNthCalledWith(1, 1)
    expect(ports.switchWorkspace).toHaveBeenNthCalledWith(2, -1)
  })

  it('honors the viewer-cycle ownership guard', () => {
    const ports = commandPorts()
    vi.mocked(ports.canUseViewerCommands).mockReturnValue(false)
    dispatchWorkbenchCommand('cycleViewMode', undefined, ports)
    dispatchWorkbenchCommand('findInFile', undefined, ports)
    dispatchWorkbenchCommand('goToLine', undefined, ports)
    expect(ports.cycleViewMode).not.toHaveBeenCalled()
    expect(ports.findInFile).not.toHaveBeenCalled()
    expect(ports.goToLine).not.toHaveBeenCalled()
  })

  it('reports terminal search handled only when the selected live owner accepts it', () => {
    const ports = commandPorts()
    expect(dispatchWorkbenchCommand('findInTerminal', undefined, ports, 'terminal')).toBe(
      true,
    )

    expect(ports.findInTerminal).toHaveBeenCalledOnce()
    expect(ports.findInFile).not.toHaveBeenCalled()

    vi.mocked(ports.findInTerminal).mockReturnValue(false)
    expect(dispatchWorkbenchCommand('findInTerminal', undefined, ports, 'terminal')).toBe(
      false,
    )
    expect(
      dispatchWorkbenchCommand('findInTerminal', undefined, ports, 'workbench'),
    ).toBe(false)
  })
})

function commandPorts(): WorkbenchCommandPorts {
  return {
    closeWebPane: vi.fn(),
    escapeWebPaneFocus: vi.fn(),
    canUseViewerCommands: vi.fn(() => true),
    cycleViewMode: vi.fn(),
    findFile: vi.fn(),
    findInFile: vi.fn(),
    findInTerminal: vi.fn(() => true),
    goToLine: vi.fn(),
    toggleTerminalFocus: vi.fn(),
    focusTerminal: vi.fn(),
    focusViewer: vi.fn(),
    focusTree: vi.fn(),
    switchWorkspace: vi.fn(),
  }
}
