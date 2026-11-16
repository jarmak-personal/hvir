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
import { diagnoseCapacityFrameObservation } from './capacity-frame-observation'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { diagnoseCapacityTerminalTags } from './capacity-terminal-fixture'
import { runCapacityTerminalComparisonScenario } from './capacity-terminal-scenario'

export async function verifyCapacityScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  liveReloadPath: HostPath,
  providerId: HarnessProviderId,
  sessions: Awaited<ReturnType<typeof createSmokeTerminalSessionStore>>,
  native?: NativeTerminalApplication,
): Promise<void> {
  const comparison = await runCapacityTerminalComparisonScenario(
    win,
    supervisor,
    host,
    liveReloadPath,
    native,
  )
  if (!comparison) {
    const observation = process.env['HVIR_CAPACITY_OBSERVATION']
    if (observation !== undefined) {
      if (
        !['diagnostic', 'tagged-diagnostic'].includes(observation) ||
        process.env['HVIR_CAPACITY_PERFORMANCE_GATE'] !== undefined
      )
        throw new Error('capacity-observation-requires-separate-diagnostic-run')
      if (observation === 'tagged-diagnostic')
        await diagnoseCapacityTerminalTags(win, supervisor, host, liveReloadPath, native)
      else await diagnoseCapacityFrameObservation(win, supervisor, native)
    } else {
      await runCapacityLoadSmoke(win, supervisor, host, liveReloadPath, native)
      sessions.set(capacityRecoverySessions(supervisor, providerId))
      // End load fixtures before the separately owned synthetic recovery contract.
      supervisor.disposeSessions()
      await runCapacityRecoverySmoke(win, supervisor)
    }
  }
  console.log('HVIR_SMOKE_OK')
}
