import type { BrowserWindow } from 'electron'
import type { HostPath, ProjectState } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  verifyTerminalRendererDestruction,
  verifyRendererRolloverRecovery,
} from './renderer-lifecycle'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyTerminalReconnectRemount } from './terminal-renderer-lifecycle'

export async function verifyTerminalLifecycleScenario(options: {
  win: BrowserWindow
  supervisor: PtySupervisor
  resources: RendererResourceScopes
  root: HostPath
  initialGeneration: number
  connectedState: ProjectState
  disconnectedState: ProjectState
  emitProjectState: (state: ProjectState) => void
  setRecoverySessions: Parameters<
    typeof verifyRendererRolloverRecovery
  >[0]['setRecoverySessions']
}): Promise<void> {
  const {
    win,
    supervisor,
    resources,
    root,
    initialGeneration,
    connectedState,
    disconnectedState,
    emitProjectState,
    setRecoverySessions,
  } = options
  const launchStatus = await ensureExplicitBareShellLaunch(win, supervisor)
  const reconnectStatus = await verifyTerminalReconnectRemount({
    win,
    supervisor,
    resources: resources,
    root: root,
    connectedState: connectedState,
    disconnectedState: disconnectedState,
    emitProjectState,
  })
  const recoveryStatus = await verifyRendererRolloverRecovery({
    win,
    supervisor,
    setRecoverySessions,
  })
  await verifyTerminalRendererDestruction({
    win,
    initialGeneration: initialGeneration,
    resources: resources,
    supervisor,
  })
  console.log(
    '[smoke] terminal renderer lifecycle OK (' +
      [launchStatus, reconnectStatus, recoveryStatus].join(' · ') +
      ' · renderer destruction cleanup)',
  )
}
