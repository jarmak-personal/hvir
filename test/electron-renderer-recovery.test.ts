import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  quit: vi.fn(),
  showMessageBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { quit: electron.quit },
  dialog: { showMessageBox: electron.showMessageBox },
}))

import { ElectronRendererRecovery } from '../src/main/window/electron-renderer-recovery'
import type { WindowHealthDiagnostic } from '../src/main/health/workbench-health-events'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import { WindowHealthTracker } from '../src/main/window/window-health-tracker'

const INITIAL = { id: 7, generation: 2 }
let consoleErrors: unknown[][]

function fixture() {
  const events: WindowHealthDiagnostic[] = []
  const deadlines: { task: () => void; canceled: boolean }[] = []
  const forcefullyCrashRenderer = vi.fn()
  const reload = vi.fn()
  const scheduledReloads: (() => void)[] = []
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: { forcefullyCrashRenderer, reload },
  }
  let owner: RendererOwner = INITIAL
  let shuttingDown = false
  const rollover = vi.fn((observed: RendererOwner) => {
    if (observed.id !== owner.id || observed.generation !== owner.generation) {
      return undefined
    }
    owner = { ...owner, generation: owner.generation + 1 }
    return owner
  })
  const recovery = new ElectronRendererRecovery({
    win: win as never,
    health: new WindowHealthTracker((event) => events.push(event)),
    currentOwner: () => owner,
    rollover,
    isShuttingDown: () => shuttingDown,
    deadlineMs: 50,
    scheduleReload: (task) => scheduledReloads.push(task),
    scheduleDeadline: (task) => {
      const deadline = { task, canceled: false }
      deadlines.push(deadline)
      return () => {
        deadline.canceled = true
      }
    },
  })
  return {
    recovery,
    win,
    events,
    deadlines,
    forcefullyCrashRenderer,
    reload,
    runScheduledReload: () => scheduledReloads.shift()?.(),
    rollover,
    owner: () => owner,
    shutDown: () => {
      shuttingDown = true
    },
  }
}

describe('ElectronRendererRecovery', () => {
  beforeEach(() => {
    electron.quit.mockReset()
    electron.showMessageBox.mockReset()
    consoleErrors = []
    vi.spyOn(console, 'error').mockImplementation((...values) => {
      consoleErrors.push(values)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('reloads after the forced-exit callback and records success after load plus readiness', () => {
    const candidate = fixture()

    expect(candidate.recovery.reloadUnresponsive(INITIAL)).toBe(true)
    expect(candidate.recovery.reloadUnresponsive(INITIAL)).toBe(false)
    expect(candidate.forcefullyCrashRenderer).toHaveBeenCalledOnce()
    expect(candidate.rollover).toHaveBeenCalledOnce()
    expect(candidate.reload).not.toHaveBeenCalled()
    expect(candidate.recovery.rendererGone(candidate.owner(), 'killed')).toBe(true)
    expect(candidate.reload).not.toHaveBeenCalled()
    candidate.runScheduledReload()
    expect(candidate.reload).toHaveBeenCalledOnce()

    candidate.recovery.rendererReady(candidate.owner())
    expect(outcomes(candidate.events)).toEqual(['reload-requested'])
    candidate.recovery.documentLoaded(candidate.owner())

    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-succeeded'])
  })

  it('presents load failure, retries the current generation, and accepts retry success', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    const candidate = fixture()
    candidate.recovery.reloadUnresponsive(INITIAL)
    const failedOwner = candidate.owner()
    candidate.recovery.rendererGone(failedOwner, 'killed')
    candidate.runScheduledReload()

    candidate.recovery.documentFailed(failedOwner)
    await vi.waitFor(() =>
      expect(candidate.forcefullyCrashRenderer).toHaveBeenCalledTimes(2),
    )
    expect(candidate.owner().generation).toBe(failedOwner.generation + 1)
    candidate.recovery.rendererGone(candidate.owner(), 'killed')
    candidate.runScheduledReload()

    candidate.recovery.documentLoaded(failedOwner)
    candidate.recovery.rendererReady(failedOwner)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())

    expect(outcomes(candidate.events)).toEqual([
      'reload-requested',
      'reload-failed',
      'reload-requested',
      'reload-succeeded',
    ])
    expect(consoleErrors).toContainEqual([
      expect.stringContaining('renderer recovery failed'),
    ])
  })

  it('shows the bounded timeout fallback and its quit action', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    const candidate = fixture()
    candidate.recovery.reloadUnresponsive(INITIAL)

    candidate.deadlines[0]?.task()
    await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledOnce())

    expect(electron.showMessageBox).toHaveBeenCalledWith(candidate.win, expect.anything())
    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-failed'])
    expect(consoleErrors).toContainEqual([expect.stringContaining('readiness-timeout')])
  })

  it('cancels timeout and fallback presentation during shutdown', async () => {
    const candidate = fixture()
    candidate.recovery.reloadUnresponsive(INITIAL)
    candidate.shutDown()
    candidate.deadlines[0]?.task()
    candidate.recovery.close()
    await Promise.resolve()

    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(candidate.deadlines[0]?.canceled).toBe(true)
    expect(outcomes(candidate.events)).toEqual([
      'reload-requested',
      'reload-failed',
      'window-closed',
    ])
    expect(consoleErrors).toContainEqual([expect.stringContaining('readiness-timeout')])
  })

  it('does not run a queued reload after recovery ownership closes', () => {
    const candidate = fixture()
    candidate.recovery.reloadUnresponsive(INITIAL)
    candidate.recovery.rendererGone(candidate.owner(), 'killed')

    candidate.recovery.close()
    candidate.runScheduledReload()

    expect(candidate.reload).not.toHaveBeenCalled()
  })

  it('defers an unexpected-exit reload beyond the process-gone callback', () => {
    const candidate = fixture()

    candidate.recovery.reloadUnexpected(INITIAL)
    expect(candidate.reload).not.toHaveBeenCalled()

    candidate.runScheduledReload()
    expect(candidate.reload).toHaveBeenCalledOnce()
  })
})

function outcomes(events: readonly WindowHealthDiagnostic[]): string[] {
  return events.flatMap((event) =>
    event.kind === 'workbench-health-recovered' ? [event.outcome] : [],
  )
}
