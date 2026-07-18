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
    dispatchWorkbenchCommand('nextWorkspace', undefined, ports)
    dispatchWorkbenchCommand('previousWorkspace', undefined, ports)

    expect(ports.closeWebPane).toHaveBeenCalledWith('pane-1')
    expect(ports.focusTree).toHaveBeenCalledOnce()
    expect(ports.switchWorkspace).toHaveBeenNthCalledWith(1, 1)
    expect(ports.switchWorkspace).toHaveBeenNthCalledWith(2, -1)
  })

  it('honors the viewer-cycle ownership guard', () => {
    const ports = commandPorts()
    vi.mocked(ports.canCycleViewMode).mockReturnValue(false)
    dispatchWorkbenchCommand('cycleViewMode', undefined, ports)
    expect(ports.cycleViewMode).not.toHaveBeenCalled()
  })
})

function commandPorts(): WorkbenchCommandPorts {
  return {
    closeWebPane: vi.fn(),
    escapeWebPaneFocus: vi.fn(),
    canCycleViewMode: vi.fn(() => true),
    cycleViewMode: vi.fn(),
    toggleTerminalFocus: vi.fn(),
    focusTerminal: vi.fn(),
    focusViewer: vi.fn(),
    focusTree: vi.fn(),
    switchWorkspace: vi.fn(),
  }
}
