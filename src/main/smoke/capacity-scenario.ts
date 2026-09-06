import type { BrowserWindow } from 'electron'
import type { HostPath, HarnessProviderId } from '../../shared'
import type { LocalHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { createSmokeTerminalSessionStore } from './terminal-session-store'
import {
  capacityRecoverySessions,
  runCapacityLoadSmoke,
  runCapacityRecoverySmoke,
} from './capacity'

export async function verifyCapacityScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  liveReloadPath: HostPath,
  providerId: HarnessProviderId,
  sessions: ReturnType<typeof createSmokeTerminalSessionStore>,
): Promise<void> {
  await runCapacityLoadSmoke(win, supervisor, host, liveReloadPath)
  sessions.set(capacityRecoverySessions(supervisor, providerId))
  // End load fixtures before the separately owned synthetic recovery contract.
  supervisor.disposeSessions()
  await runCapacityRecoverySmoke(win, supervisor)
}
