import { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import { plainShellProvider } from '../harness/harness-provider'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import { SmokeCleanup } from './cleanup'
import { stopPtyAndWaitForExit } from './pty-lifecycle'

const MAIN_SMOKE_OWNER_ID = 0

/** Load and exercise Electron's native node-pty ABI without creating a renderer. */
export async function runNativePtySmoke(projectRoot: HostPath): Promise<number> {
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  const cleanup = new SmokeCleanup()
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('PTY supervisor', () => supervisor.disposeAllAndWait())

  try {
    assertNoWindows('before native PTY launch')
    await host.connect()
    const terminal = await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: projectRoot,
      ownerId: MAIN_SMOKE_OWNER_ID,
      sessionId: 'native-pty-smoke',
    })
    await stopPtyAndWaitForExit({
      supervisor,
      terminal,
      scenario: 'native PTY exit',
    })
    if (supervisor.get(terminal.id)) {
      throw new Error(`native PTY remained supervised after exit (pid=${terminal.pid})`)
    }
    assertNoWindows('after native PTY exit')
    console.log(`[smoke] native node-pty ABI OK (pid ${terminal.pid} · no window)`)
    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (error) {
    console.error('HVIR_SMOKE_FAIL', error)
    return 1
  } finally {
    await cleanup.run()
  }
}

function assertNoWindows(phase: string): void {
  const count = BrowserWindow.getAllWindows().length
  if (count !== 0) {
    throw new Error(`${phase}: expected no BrowserWindow, found ${count}`)
  }
}
