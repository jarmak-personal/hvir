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
  let crashed = false
  let processId = 202
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      forcefullyCrashRenderer,
      reload,
      getOSProcessId: vi.fn(() => processId),
      isCrashed: vi.fn(() => crashed),
    },
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
    crashCurrentRenderer: () => {
      crashed = true
    },
    replaceCurrentProcess: () => {
      processId += 1
    },
  }
}

function requestUnresponsiveReload(candidate: ReturnType<typeof fixture>) {
  const episode = candidate.recovery.unresponsive(INITIAL)
  candidate.recovery.resolveUnresponsiveChoice(episode, true)
  return episode
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

  it('immediately replaces the process and defers final navigation past its exit', () => {
    const candidate = fixture()

    const episode = requestUnresponsiveReload(candidate)
    candidate.recovery.resolveUnresponsiveChoice(episode, true)
    expect(candidate.forcefullyCrashRenderer).toHaveBeenCalledOnce()
    expect(candidate.rollover).toHaveBeenCalledOnce()
    expect(candidate.reload).toHaveBeenCalledOnce()
    expect(candidate.forcefullyCrashRenderer.mock.invocationCallOrder[0]).toBeLessThan(
      candidate.reload.mock.invocationCallOrder[0] ?? 0,
    )
    expect(candidate.recovery.rendererGone(candidate.owner(), 'killed')).toBe(true)
    expect(candidate.reload).toHaveBeenCalledOnce()
    candidate.runScheduledReload()
    expect(candidate.reload).toHaveBeenCalledTimes(2)

    candidate.recovery.rendererReady(candidate.owner())
    expect(outcomes(candidate.events)).toEqual(['reload-requested'])
    candidate.recovery.documentLoaded(candidate.owner())

    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-succeeded'])
  })

  it('attributes a late forced exit without hiding a later replacement crash', () => {
    const candidate = fixture()

    requestUnresponsiveReload(candidate)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())

    expect(candidate.recovery.rendererGone(candidate.owner(), 'killed')).toBe(true)
    candidate.crashCurrentRenderer()
    expect(candidate.recovery.rendererGone(candidate.owner(), 'crashed')).toBe(false)
    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-succeeded'])
  })

  it('does not hide a replacement crash when the forced exit event was omitted', () => {
    const candidate = fixture()

    requestUnresponsiveReload(candidate)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())
    candidate.crashCurrentRenderer()

    expect(candidate.recovery.rendererGone(candidate.owner(), 'crashed')).toBe(false)
    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-succeeded'])
  })

  it('does not absorb an exit from a process other than the usable replacement', () => {
    const candidate = fixture()

    requestUnresponsiveReload(candidate)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())
    candidate.replaceCurrentProcess()

    expect(candidate.recovery.rendererGone(candidate.owner(), 'killed')).toBe(false)
    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-succeeded'])
  })

  it('does not read replacement process state after the window is destroyed', () => {
    const candidate = fixture()

    requestUnresponsiveReload(candidate)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())
    expect(candidate.win.webContents.getOSProcessId).toHaveBeenCalledOnce()

    candidate.win.isDestroyed.mockReturnValue(true)
    expect(candidate.recovery.rendererGone(candidate.owner(), 'killed')).toBe(false)
    expect(candidate.win.webContents.getOSProcessId).toHaveBeenCalledOnce()
    expect(candidate.win.webContents.isCrashed).not.toHaveBeenCalled()
  })

  it('does not record replacement process identity after window teardown', () => {
    const candidate = fixture()

    requestUnresponsiveReload(candidate)
    candidate.win.isDestroyed.mockReturnValue(true)
    candidate.recovery.documentLoaded(candidate.owner())
    candidate.recovery.rendererReady(candidate.owner())

    expect(candidate.win.webContents.getOSProcessId).not.toHaveBeenCalled()
  })

  it('presents load failure, retries the current generation, and accepts retry success', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    const candidate = fixture()
    requestUnresponsiveReload(candidate)
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
    expect(candidate.reload).toHaveBeenCalledTimes(4)

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
    requestUnresponsiveReload(candidate)

    candidate.deadlines[0]?.task()
    await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledOnce())

    expect(electron.showMessageBox).toHaveBeenCalledWith(candidate.win, expect.anything())
    expect(outcomes(candidate.events)).toEqual(['reload-requested', 'reload-failed'])
    expect(consoleErrors).toContainEqual([expect.stringContaining('readiness-timeout')])
  })

  it('cancels timeout and fallback presentation during shutdown', async () => {
    const candidate = fixture()
    requestUnresponsiveReload(candidate)
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

  it('does not run the deferred post-exit navigation after recovery ownership closes', () => {
    const candidate = fixture()
    requestUnresponsiveReload(candidate)
    candidate.recovery.rendererGone(candidate.owner(), 'killed')

    candidate.recovery.close()
    candidate.runScheduledReload()

    expect(candidate.reload).toHaveBeenCalledOnce()
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
