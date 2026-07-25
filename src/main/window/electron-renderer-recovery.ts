import { app, dialog, type BrowserWindow } from 'electron'

import type { RendererOwner } from '../renderer-resource-scopes'
import {
  RendererRecoveryMonitor,
  type RendererRecoveryAttempt,
  type RendererRecoveryFailure,
} from './renderer-recovery-monitor'
import {
  WindowHealthTracker,
  type WindowUnresponsiveEpisode,
} from './window-health-tracker'
import { ownsUnresponsiveRecovery } from './window-policy'

export interface ElectronRendererRecoveryOptions {
  readonly win: BrowserWindow
  readonly health: WindowHealthTracker
  readonly currentOwner: () => RendererOwner
  readonly rollover: (owner: RendererOwner) => RendererOwner | undefined
  readonly isShuttingDown: () => boolean
  readonly deadlineMs?: number
  readonly scheduleDeadline?: (task: () => void, delayMs: number) => () => void
}

/** Owns bounded renderer replacement attempts and their native failure presentation. */
export class ElectronRendererRecovery {
  private readonly monitor: RendererRecoveryMonitor
  private forcedExitOwner?: RendererOwner
  private episode?: WindowUnresponsiveEpisode

  constructor(private readonly options: ElectronRendererRecoveryOptions) {
    this.monitor = new RendererRecoveryMonitor({
      deadlineMs: options.deadlineMs,
      schedule: options.scheduleDeadline,
      onSucceeded: (attempt) => this.succeeded(attempt),
      onFailed: (attempt, failure) => this.failed(attempt, failure),
    })
  }

  owns(owner: RendererOwner): boolean {
    return this.monitor.owns(owner)
  }

  unresponsive(owner: RendererOwner): WindowUnresponsiveEpisode {
    return this.options.health.unresponsive(owner)
  }

  resolveUnresponsiveChoice(episode: WindowUnresponsiveEpisode, reload: boolean): void {
    if (!ownsUnresponsiveRecovery(this.options.currentOwner(), episode.owner)) return
    if (reload) this.start(episode.owner, episode)
    else this.options.health.recoverUnresponsive(episode, 'wait-selected')
  }

  reloadUnresponsive(owner: RendererOwner): boolean {
    if (this.monitor.owns(owner)) return false
    return this.start(owner, this.options.health.unresponsive(owner))
  }

  documentLoaded(owner: RendererOwner): void {
    this.monitor.documentLoaded(owner)
  }

  rendererReady(owner: RendererOwner): void {
    this.monitor.rendererReady(owner)
  }

  documentFailed(owner: RendererOwner): void {
    this.monitor.fail(owner, 'document-load-failed')
  }

  responsive(owner: RendererOwner): void {
    this.options.health.responsive(owner)
  }

  rendererGone(
    currentOwner: RendererOwner,
    reason: Electron.RenderProcessGoneDetails['reason'],
  ): boolean {
    if (this.forcedExitOwner) {
      const exitedOwner = this.forcedExitOwner
      this.forcedExitOwner = undefined
      this.options.health.rendererGone(exitedOwner, reason, 'forced-for-reload')
      // The reload requested before the forced exit can be discarded with the old
      // renderer. Reassert it at the exit boundary without rolling resources again.
      if (this.monitor.owns(currentOwner)) this.reload(currentOwner)
      return true
    }
    if (!this.monitor.owns(currentOwner)) return false
    this.options.health.rendererGone(currentOwner, reason, 'replacement-failed')
    this.monitor.fail(currentOwner, 'renderer-exited')
    return true
  }

  reloadUnexpected(replacement: RendererOwner): void {
    this.options.health.documentStarted()
    this.monitor.start(replacement)
    this.reload(replacement)
  }

  private reload(owner: RendererOwner): void {
    try {
      this.options.win.webContents.reload()
    } catch (error) {
      console.error('[window] renderer reload could not be started', error)
      this.monitor.fail(owner, 'reload-failed')
    }
  }

  close(): void {
    this.monitor.close()
    if (this.episode) {
      this.options.health.recoverUnresponsive(this.episode, 'window-closed')
      this.episode = undefined
    }
    this.forcedExitOwner = undefined
  }

  dispose(): void {
    this.monitor.dispose()
  }

  private start(
    observedOwner: RendererOwner,
    episode?: WindowUnresponsiveEpisode,
  ): boolean {
    const { win } = this.options
    if (
      win.isDestroyed() ||
      this.options.isShuttingDown() ||
      !ownsUnresponsiveRecovery(this.options.currentOwner(), observedOwner)
    ) {
      return false
    }
    const replacement = this.options.rollover(observedOwner)
    if (!replacement) return false
    this.episode = episode
    if (episode) this.options.health.recoverUnresponsive(episode, 'reload-requested')
    this.options.health.documentStarted()
    if (!this.monitor.start(replacement)) return false
    this.forcedExitOwner = observedOwner
    console.info(
      `[window] renderer recovery requested from generation ${observedOwner.generation} to ${replacement.generation}`,
    )
    try {
      win.webContents.forcefullyCrashRenderer()
      win.webContents.reload()
    } catch (error) {
      this.forcedExitOwner = undefined
      console.error('[window] renderer reload could not be started', error)
      this.monitor.fail(replacement, 'reload-failed')
    }
    return true
  }

  private succeeded(attempt: RendererRecoveryAttempt): void {
    if (this.episode) {
      this.options.health.recoverUnresponsive(this.episode, 'reload-succeeded')
      this.episode = undefined
    }
    console.info(
      `[window] renderer recovery succeeded for generation ${attempt.owner.generation}`,
    )
  }

  private failed(
    attempt: RendererRecoveryAttempt,
    failure: RendererRecoveryFailure,
  ): void {
    if (this.episode)
      this.options.health.recoverUnresponsive(this.episode, 'reload-failed')
    console.error(
      `[window] renderer recovery failed for generation ${attempt.owner.generation}: ${failure}`,
    )
    void this.showFailure(attempt, failure)
  }

  private async showFailure(
    attempt: RendererRecoveryAttempt,
    failure: RendererRecoveryFailure,
  ): Promise<void> {
    const { win } = this.options
    if (
      win.isDestroyed() ||
      this.options.isShuttingDown() ||
      !this.monitor.isFailed(attempt)
    ) {
      return
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'hvir recovery failed',
      message: 'hvir could not restore its window.',
      detail: failureDetail(failure),
      buttons: ['Retry', 'Quit hvir'],
      defaultId: 0,
      cancelId: 1,
    })
    if (
      win.isDestroyed() ||
      this.options.isShuttingDown() ||
      !this.monitor.isFailed(attempt)
    ) {
      return
    }
    if (response === 0) this.start(this.options.currentOwner(), this.episode)
    else app.quit()
  }
}

function failureDetail(failure: RendererRecoveryFailure): string {
  if (failure === 'document-load-failed') {
    return 'The replacement workbench document did not load.'
  }
  if (failure === 'renderer-exited') {
    return 'The replacement renderer exited before the workbench became usable.'
  }
  if (failure === 'reload-failed') {
    return 'hvir could not start the replacement workbench.'
  }
  return 'The replacement workbench did not become usable in time.'
}
