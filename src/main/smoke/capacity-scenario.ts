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
import {
  capacityLargeViewportSelected,
  qualifyCapacityNativeLargeViewport,
} from './capacity-native-large-viewport'
import {
  diagnoseCapacityNativePairedProcess,
  runCapacityTerminalComparisonScenario,
} from './capacity-terminal-scenario'

export async function verifyCapacityScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  liveReloadPath: HostPath,
  providerId: HarnessProviderId,
  sessions: Awaited<ReturnType<typeof createSmokeTerminalSessionStore>>,
  native?: NativeTerminalApplication,
): Promise<void> {
  if (capacityLargeViewportSelected(process.env, process.platform)) {
    await qualifyCapacityNativeLargeViewport(
      win,
      supervisor,
      host,
      liveReloadPath,
      native,
    )
    console.log('HVIR_SMOKE_OK')
    return
  }
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
        ![
          'diagnostic',
          'tagged-diagnostic',
          'sequence-diagnostic',
          'native-paired-diagnostic',
          'native-effects-diagnostic',
        ].includes(observation) ||
        process.env['HVIR_CAPACITY_PERFORMANCE_GATE'] !== undefined
      )
        throw new Error('capacity-observation-requires-separate-diagnostic-run')
    }
    if (observation === 'native-effects-diagnostic' && !native?.effects)
      throw new Error('capacity-native-effects-diagnostic-requires-native')
    if (observation !== undefined && observation !== 'native-effects-diagnostic') {
      if (observation === 'native-paired-diagnostic')
        await diagnoseCapacityNativePairedProcess(
          win,
          supervisor,
          host,
          liveReloadPath,
          native,
        )
      else if (
        observation === 'tagged-diagnostic' ||
        observation === 'sequence-diagnostic'
      )
        await diagnoseCapacityTerminalTags(
          win,
          supervisor,
          host,
          liveReloadPath,
          native,
          observation === 'sequence-diagnostic',
        )
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
