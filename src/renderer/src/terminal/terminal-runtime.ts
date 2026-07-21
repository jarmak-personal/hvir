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
import type {
  TerminalColorTheme,
  TerminalLinkActivation,
  TerminalPane,
} from './terminal-pane'

const PTY_RESIZE_DEBOUNCE_MS = 75

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
}

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, TerminalRuntime>()

  acquire(options: TerminalRuntimeOptions): TerminalRuntime {
    const existing = this.runtimes.get(options.sessionId)
    if (existing) {
      existing.update(options)
      return existing
    }
    const runtime = new TerminalRuntime(options)
    this.runtimes.set(options.sessionId, runtime)
    return runtime
  }

  disposeSession(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.delete(id)
    runtime.dispose()
  }

  disposeMissingWorkspaces(roots: readonly HostPath[]): void {
    for (const [id, runtime] of this.runtimes) {
      if (roots.some((root) => hostPathEquals(root, runtime.workspaceRoot))) continue
      this.runtimes.delete(id)
      runtime.dispose()
    }
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
    this.runtimes.clear()
  }
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
  private disposed = false

  constructor(options: TerminalRuntimeOptions) {
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

  synchronizeConnection(): void {
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
    })
    this.options.onTelemetry(undefined)
  }

  attach(container: HTMLElement): void {
    if (this.disposed) return
    this.container = container
    if (this.pane) {
      this.pane.reparent(container)
      if (this.options.active) this.focus()
      return
    }
    if (this.options.connectionState === 'connected') void this.ensureStarted()
  }

  detach(container: HTMLElement): void {
    if (this.container === container) this.container = undefined
  }

  focus(): void {
    this.pane?.redraw()
    this.pane?.focus()
    this.options.onFocus()
  }

  restart(): void {
    if (this.disposed) return
    this.restartRequested = true
    this.releaseSurface(true)
    this.updateSnapshot({
      title: this.options.fallbackTitle,
      status: 'Starting…',
      exited: false,
    })
    void this.ensureStarted()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.releaseSurface(true)
    this.listeners.clear()
  }

  private async ensureStarted(): Promise<void> {
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
    const manualRestart = this.restartRequested
    this.disconnected = false
    this.restartRequested = false
    this.updateSnapshot({ ...this.currentSnapshot, exited: false })
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
      pane.mount(this.container ?? container)
      pane.redraw()
      this.installPtyListeners()

      const resume =
        this.options.supportsResume &&
        Boolean(this.options.harnessSessionId) &&
        (this.options.resumeOnStart || reconnect || manualRestart)
      const result = await window.hvir.invoke('pty:start', {
        sessionId: this.options.sessionId,
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
          window.hvir.send('pty:kill', { id: this.options.sessionId })
        }
        return
      }
      if (result.outcome === 'resume-unavailable') {
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: resumeUnavailableStatus(result.reason),
          exited: true,
        })
        return
      }
      this.started = true
      this.hasStarted = true
      this.options.onIdentity(result.harnessSessionId, result.identityStatus)
      this.options.onCapabilities(result.capabilities)
      this.options.onStarted()
      if (this.pendingInput) {
        window.hvir.send('pty:write', {
          id: this.options.sessionId,
          data: this.pendingInput,
        })
        this.pendingInput = ''
      }
      this.updateSnapshot({
        ...this.currentSnapshot,
        status: result.resumed
          ? `Resumed · pid ${result.pid}`
          : resume
            ? `New session · pid ${result.pid}`
            : manualRestart
              ? `Restarted · pid ${result.pid}`
              : reconnect
                ? `New shell · pid ${result.pid}`
                : `pid ${result.pid}`,
      })
      if (this.options.active) this.focus()
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: error instanceof Error ? error.message : String(error),
          exited: true,
        })
      }
    } finally {
      if (generation === this.startGeneration) this.starting = false
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
        if (this.started)
          window.hvir.send('pty:write', { id: this.options.sessionId, data })
        else this.pendingInput += data
      }),
      pane.events.onResize(({ cols, rows }) => {
        this.terminalSize = { cols, rows }
        if (!this.started) return
        if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer)
        this.resizeTimer = window.setTimeout(() => {
          this.resizeTimer = undefined
          window.hvir.send('pty:resize', {
            id: this.options.sessionId,
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

  private installPtyListeners(): void {
    this.eventDisposers = [
      window.hvir.on('pty:data', ({ id, data }) => {
        if (id !== this.options.sessionId) return
        this.options.onOutput()
        this.outputWriter?.write(data)
      }),
      window.hvir.on('pty:exit', ({ id, exitCode }) => {
        if (id !== this.options.sessionId) return
        this.started = false
        this.updateSnapshot({
          ...this.currentSnapshot,
          status: `Exited (${exitCode})`,
          exited: true,
        })
      }),
      window.hvir.on('pty:telemetry', ({ id, telemetry }) => {
        if (id === this.options.sessionId) this.options.onTelemetry(telemetry)
      }),
      window.hvir.on('pty:identity', ({ id, harnessSessionId, identityStatus }) => {
        if (id === this.options.sessionId) {
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
    if (kill && this.started) window.hvir.send('pty:kill', { id: this.options.sessionId })
    this.started = false
  }

  private updateSnapshot(snapshot: TerminalRuntimeSnapshot): void {
    if (
      snapshot.title === this.currentSnapshot.title &&
      snapshot.status === this.currentSnapshot.status &&
      snapshot.exited === this.currentSnapshot.exited
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

function resumeUnavailableStatus(reason: 'artifact-missing'): string {
  switch (reason) {
    case 'artifact-missing':
      return 'Resume unavailable · session data is missing'
  }
}

function baseTerminalTheme(): TerminalColorTheme {
  return {
    background: '#111318',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#39445a',
    black: '#20242c',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d8dee9',
  }
}
