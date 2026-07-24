import { describe, expect, it } from 'vitest'

import {
  clamp,
  fitTerminalHeight,
} from '../src/renderer/src/workbench/workbench-layout-policy'
import { fitSplitPrimaryWidth } from '../src/renderer/src/layout/split-layout-policy'
import {
  WorkspacePaneStateSession,
  type WorkspacePaneState,
} from '../src/renderer/src/workbench/workspace-pane-state'
import { asHostId, hostPath, localPath } from '../src/shared'

describe('workbench layout policy', () => {
  it('clamps tracks to the usable shell area', () => {
    expect(clamp(100, 160, 520)).toBe(160)
    expect(clamp(700, 160, 520)).toBe(520)
    expect(fitTerminalHeight(900, 800)).toBe(619)
    expect(fitTerminalHeight(20, 800)).toBe(160)
    expect(fitSplitPrimaryWidth(900, 800, 240)).toBe(559)
    expect(fitSplitPrimaryWidth(20, 800, 240)).toBe(240)
  })
})

describe('workspace pane state session', () => {
  it('remembers independent transient modes by host-qualified workspace', () => {
    const session = new WorkspacePaneStateSession()
    const local = localPath('/srv/app')
    const remote = hostPath(asHostId('build-host'), '/srv/app')
    const other = localPath('/srv/other')
    const localState: WorkspacePaneState = {
      terminalMode: 'maximized',
      terminalRailCompact: true,
      treeCollapsed: true,
    }
    const remoteState: WorkspacePaneState = {
      terminalMode: 'collapsed',
      terminalRailCompact: false,
      treeCollapsed: false,
    }

    session.write(local, localState)
    session.write(remote, remoteState)

    expect(session.read(local)).toEqual(localState)
    expect(session.read(remote)).toEqual(remoteState)
    expect(session.read(other)).toEqual({
      terminalMode: 'restored',
      terminalRailCompact: false,
      treeCollapsed: false,
    })
  })
})
