import {
  hostPathEquals,
  type ComposerSubmitMode,
  type HarnessModifiedKeyProtocol,
  type HarnessProfileId,
  type HarnessProviderCapabilities,
  type HarnessTelemetry,
  type HostConnectionState,
  type HostPath,
  type TerminalIdentityStatus,
} from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import { SynchronizedOutputWriter } from './synchronized-output'
import type { TerminalLinkActivation, TerminalPane } from './terminal-pane'
import type { TerminalPresentation } from './terminal-pane'
import {
  baseTerminalTheme,
  resumeUnavailableStatus,
} from './terminal-runtime-presentation'

const PTY_RESIZE_DEBOUNCE_MS = 75

export interface FreshTerminalStart {
  readonly sessionId: string
  readonly status: string
  readonly harnessSessionId?: string
  readonly identityStatus: TerminalIdentityStatus
  readonly capabilities: HarnessProviderCapabilities
}

export type TerminalRecoveryFailure = {
  readonly kind: 'resume-unavailable'
  readonly reason: 'artifact-missing'
}

export interface TerminalRuntimeOptions {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly supportsResume: boolean
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly resumeOnStart: boolean
  readonly position: number
  readonly active: boolean
  readonly presentation: TerminalPresentation
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly composerSubmitMode: ComposerSubmitMode
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly connectionState: HostConnectionState
  readonly onTitle: (title: string) => void
  readonly onStatus: (status: string) => void
  readonly onTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly onIdentity: (
    harnessSessionId: string | undefined,
    status: TerminalIdentityStatus,
  ) => void
  readonly onStarted: () => void
  readonly onFreshStarted: (started: FreshTerminalStart) => void
  readonly onCapabilities: (capabilities: HarnessProviderCapabilities) => void
  readonly onInput: (data: string) => void
  readonly onOutput: () => void
  readonly onBell: () => void
  readonly onFocus: () => void
  readonly onLink: (activation: TerminalLinkActivation) => void
}

export interface TerminalRuntimeSnapshot {
  readonly title: string
  readonly status: string
  readonly exited: boolean
  readonly recoveryFailure?: TerminalRecoveryFailure
}

export class TerminalRuntime {
  private options: TerminalRuntimeOptions
  private currentSnapshot: TerminalRuntimeSnapshot
  private readonly listeners = new Set<() => void>()
  private container?: HTMLElement
  private pane?: TerminalPane
  private outputWriter?: SynchronizedOutputWriter
  private paneDisposers: Array<() => void | Promise<void>> = []
  private eventDisposers: Array<() => void | Promise<void>> = []
  private resizeTimer?: number
  private terminalSize = { cols: 80, rows: 24 }
  private pendingInput = ''
  private startGeneration = 0
  private starting = false
  private started = false
  private hasStarted = false
  private disconnected = false
  private appliedConnectionState: HostConnectionState
  private restartRequested = false
  private pendingReplacementId?: string
  private activePtyId?: string
  private disposed = false

  constructor(
    options: TerminalRuntimeOptions,
    private readonly replaceSessionId: (
      previousId: string,
      nextId: string,
      runtime: TerminalRuntime,
    ) => void,
  ) {
    this.options = options
    // Connected is the neutral initial value; the first synchronization must still
    // publish a disconnected/connecting state without requiring a mounted pane.
    this.appliedConnectionState = 'connected'
    this.currentSnapshot = {
      title: options.fallbackTitle,
      status: 'Starting…',
      exited: false,
    }
  }

  get workspaceRoot(): HostPath {
    return this.options.workspaceRoot
  }

  snapshot = (): TerminalRuntimeSnapshot => this.currentSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(options: TerminalRuntimeOptions): void {
    if (
      options.profileId !== this.options.profileId ||
      options.launchRevision !== this.options.launchRevision ||
      !hostPathEquals(options.cwd, this.options.cwd)
    ) {
      throw new Error('Live terminal launch context cannot change')
    }
    this.options = options
  }

  synchronizeLifecycle(): void {
    this.pane?.setPresentation(this.options.presentation)
    const connectionState = this.options.connectionState
    if (this.appliedConnectionState === connectionState) return
    this.appliedConnectionState = connectionState
    if (connectionState === 'connected') {
      void this.ensureStarted()
      return
    }
    this.disconnected = true
    this.releaseSurface(false)
    this.updateSnapshot({
      title: this.options.fallbackTitle,
      status: connectionState,
      exited: false,
      recoveryFailure: undefined,
    })
    this.options.onTelemetry(undefined)
  }

  attach(container: HTMLElement, presentation = this.options.presentation): void {
    if (this.disposed) return
    this.container = container
    if (this.pane) {
      this.pane.reparent(container)
      this.pane.setPresentation(presentation)
      if (this.options.active) this.focus()
      return
    }
    if (this.options.connectionState === 'connected') void this.ensureStarted()
  }

  detach(container: HTMLElement): void {
    if (this.container !== container) return
    this.container = undefined
    this.pane?.setPresentation('hidden')
  }

  focus(): void {
    this.pane?.focus()
    this.options.onFocus()
  }

  restart(): void {
    if (this.disposed || this.starting || this.started || !this.currentSnapshot.exited) {
      return
    }
    this.restartRequested = true
    this.releaseSurface(true)
    this.updateSnapshot({
      title: this.options.fallbackTitle,
      status: 'Starting…',
      exited: false,
      recoveryFailure: undefined,
    })
    void this.ensureStarted()
  }

  startFresh(): void {
    if (
      this.disposed ||
      this.starting ||
      this.started ||
      !this.currentSnapshot.exited ||
      !this.options.supportsResume ||
      !this.options.harnessSessionId
    ) {
      return
    }
    const sessionId = crypto.randomUUID()
    this.pendingReplacementId = sessionId
    this.restartRequested = false
    this.releaseSurface(true)
    this.updateSnapshot({
      title: this.options.fallbackTitle,
      status: 'Starting fresh…',
      exited: false,
      recoveryFailure: undefined,
    })
    void this.ensureStarted({
      sessionId,
      replacesSessionId: this.options.sessionId,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.releaseSurface(true)
    this.listeners.clear()
  }

  cancelPendingReplacement(): string | undefined {
    const id = this.pendingReplacementId
    this.pendingReplacementId = undefined
    return id
  }

  private async ensureStarted(
    replacement?: Readonly<{
      sessionId: string
      replacesSessionId: string
    }>,
  ): Promise<void> {
    if (
      this.disposed ||
      this.starting ||
      this.started ||
      !this.container ||
      this.options.connectionState !== 'connected'
    ) {
      return
    }
    this.starting = true
    const generation = ++this.startGeneration
    const container = this.container
    const reconnect = this.disconnected && this.hasStarted
    const manualRestart = !replacement && this.restartRequested
    const sessionId = replacement?.sessionId ?? this.options.sessionId
    this.disconnected = false
    this.restartRequested = false
    this.updateSnapshot({
      ...this.currentSnapshot,
      exited: false,
      recoveryFailure: undefined,
    })
    this.options.onTelemetry(undefined)
    try {
      if (reconnect && this.options.supportsResume && !this.options.harnessSessionId) {
        throw new Error('Exact harness session id unavailable; start a new terminal')
      }
      const pane = await createGhosttyTerminalPane(baseTerminalTheme(), {
        modifiedKeyProtocol: this.options.modifiedKeyProtocol,
        metaEnterAliasesControl: this.options.metaEnterAliasesControl,
        composerSubmitMode: this.options.composerSubmitMode,
      })
      if (!this.isCurrent(generation)) {
        pane.dispose()
        return
      }
      this.pane = pane
      this.installPaneListeners(pane)
      pane.setPresentation(this.options.presentation)
      pane.mount(this.container ?? container)
      pane.redraw()
      this.installPtyListeners(sessionId)

      const resume =
        !replacement &&
        this.options.supportsResume &&
        Boolean(this.options.harnessSessionId) &&
        (this.options.resumeOnStart || reconnect || manualRestart)
      const result = await window.hvir.invoke('pty:start', {
        sessionId,
        replacesSessionId: replacement?.replacesSessionId,
        profileId: this.options.profileId,
        launchRevision: this.options.launchRevision,
        cwd: this.options.cwd,
        cols: this.terminalSize.cols,
        rows: this.terminalSize.rows,
        title: this.currentSnapshot.title,
        position: this.options.position,
        active: this.options.active,
        composerSubmitMode: this.options.composerSubmitMode,
        resume,
        harnessSessionId: resume ? this.options.harnessSessionId : undefined,
        acknowledgeRisk: this.options.riskAcknowledged,
      })
      if (!this.isCurrent(generation)) {
        if (result.outcome === 'started') {
          window.hvir.send('pty:kill', { id: result.id })
        }
        return
      }
      if (result.outcome === 'resume-unavailable') {
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: resumeUnavailableStatus(result.reason),
          exited: true,
          recoveryFailure: {
            kind: 'resume-unavailable',
            reason: result.reason,
          },
        })
        return
      }
      this.started = true
      this.hasStarted = true
      this.activePtyId = result.id
      const status = result.resumed
        ? `Resumed · pid ${result.pid}`
        : replacement
          ? `New session · pid ${result.pid}`
          : resume
            ? `New session · pid ${result.pid}`
            : manualRestart
              ? `Restarted · pid ${result.pid}`
              : reconnect
                ? `New shell · pid ${result.pid}`
                : `pid ${result.pid}`
      if (this.pendingInput) {
        window.hvir.send('pty:write', {
          id: result.id,
          data: this.pendingInput,
        })
        this.pendingInput = ''
      }
      this.updateSnapshot({
        ...this.currentSnapshot,
        status,
        recoveryFailure: undefined,
      })
      if (replacement) {
        this.pendingReplacementId = undefined
        this.replaceSessionId(replacement.replacesSessionId, result.id, this)
        this.options.onFreshStarted({
          sessionId: result.id,
          status,
          harnessSessionId: result.harnessSessionId,
          identityStatus: result.identityStatus,
          capabilities: result.capabilities,
        })
      } else {
        this.options.onIdentity(result.harnessSessionId, result.identityStatus)
        this.options.onCapabilities(result.capabilities)
        this.options.onStarted()
      }
      if (this.options.active) this.focus()
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: error instanceof Error ? error.message : String(error),
          exited: true,
          recoveryFailure: undefined,
        })
      }
    } finally {
      if (generation === this.startGeneration) {
        this.starting = false
        if (replacement && this.pendingReplacementId === replacement.sessionId) {
          this.pendingReplacementId = undefined
        }
      }
    }
  }

  private installPaneListeners(pane: TerminalPane): void {
    this.outputWriter = new SynchronizedOutputWriter(
      (data) => pane.write(data),
      () => pane.redraw(),
    )
    this.paneDisposers = [
      pane.events.onData((data) => {
        this.options.onInput(data)
        if (this.started) window.hvir.send('pty:write', { id: this.activePtyId!, data })
        else this.pendingInput += data
      }),
      pane.events.onResize(({ cols, rows }) => {
        this.terminalSize = { cols, rows }
        if (!this.started) return
        if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer)
        this.resizeTimer = window.setTimeout(() => {
          this.resizeTimer = undefined
          window.hvir.send('pty:resize', {
            id: this.activePtyId!,
            ...this.terminalSize,
          })
        }, PTY_RESIZE_DEBOUNCE_MS)
      }),
      pane.events.onTitle((title) => {
        const next = title.trim() || this.options.fallbackTitle
        this.updateSnapshot({ ...this.currentSnapshot, title: next })
        this.options.onTitle(next)
      }),
      pane.events.onBell(() => this.options.onBell()),
      pane.events.onOsc((event) => console.debug('[terminal:osc]', event)),
      pane.events.onLink((target) => this.options.onLink(target)),
    ]
  }

  private installPtyListeners(sessionId: string): void {
    this.eventDisposers = [
      window.hvir.on('pty:data', ({ id, data }) => {
        if (id !== sessionId) return
        this.options.onOutput()
        this.outputWriter?.write(data)
      }),
      window.hvir.on('pty:exit', ({ id, exitCode }) => {
        if (id !== sessionId) return
        this.started = false
        this.activePtyId = undefined
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: `Exited (${exitCode})`,
          exited: true,
          recoveryFailure: undefined,
        })
      }),
      window.hvir.on('pty:telemetry', ({ id, telemetry }) => {
        if (id === sessionId) this.options.onTelemetry(telemetry)
      }),
      window.hvir.on('pty:identity', ({ id, harnessSessionId, identityStatus }) => {
        if (id === sessionId) {
          this.options.onIdentity(harnessSessionId, identityStatus)
        }
      }),
    ]
  }

  private releaseSurface(kill: boolean): void {
    this.startGeneration++
    this.starting = false
    for (const dispose of this.eventDisposers) void dispose()
    for (const dispose of this.paneDisposers) void dispose()
    this.eventDisposers = []
    this.paneDisposers = []
    if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer)
    this.resizeTimer = undefined
    this.outputWriter?.dispose()
    this.outputWriter = undefined
    this.pendingInput = ''
    this.pane?.dispose()
    this.pane = undefined
    if (kill && this.started && this.activePtyId) {
      window.hvir.send('pty:kill', { id: this.activePtyId })
    }
    this.started = false
    this.activePtyId = undefined
  }

  private updateSnapshot(snapshot: TerminalRuntimeSnapshot): void {
    if (
      snapshot.title === this.currentSnapshot.title &&
      snapshot.status === this.currentSnapshot.status &&
      snapshot.exited === this.currentSnapshot.exited &&
      recoveryFailureEquals(
        snapshot.recoveryFailure,
        this.currentSnapshot.recoveryFailure,
      )
    ) {
      return
    }
    this.currentSnapshot = snapshot
    this.options.onStatus(snapshot.status)
    for (const listener of this.listeners) listener()
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.startGeneration
  }
}

function recoveryFailureEquals(
  left: TerminalRecoveryFailure | undefined,
  right: TerminalRecoveryFailure | undefined,
): boolean {
  return left?.kind === right?.kind && left?.reason === right?.reason
}
