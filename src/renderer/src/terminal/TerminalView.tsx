import { useEffect, useRef, useState, type ReactElement } from 'react'

import type {
  HarnessTelemetry,
  HarnessProfileId,
  HarnessProviderCapabilities,
  HostConnectionState,
  HostPath,
  TerminalIdentityStatus,
} from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import { SynchronizedOutputWriter } from './synchronized-output'
import type { TerminalLinkActivation, TerminalPane } from './terminal-pane'
import type { TerminalColorTheme } from './terminal-pane'
import { useAppTheme, type AppTheme } from '../theme'
import type { TerminalThemeOverride } from '../settings/settings'

interface TerminalViewProps {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly supportsResume: boolean
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly resumeOnStart: boolean
  readonly position: number
  readonly slot: 'primary' | 'secondary'
  readonly visible: boolean
  readonly active: boolean
  readonly themeOverride: TerminalThemeOverride
  readonly cwd: HostPath
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

const PTY_RESIZE_DEBOUNCE_MS = 75

export function TerminalView({
  sessionId,
  profileId,
  launchRevision,
  riskAcknowledged,
  supportsResume,
  fallbackTitle,
  harnessSessionId,
  resumeOnStart,
  position,
  slot,
  visible,
  active,
  themeOverride,
  cwd,
  connectionState,
  onTitle,
  onStatus,
  onTelemetry,
  onIdentity,
  onStarted,
  onCapabilities,
  onInput,
  onOutput,
  onBell,
  onFocus,
  onLink,
}: TerminalViewProps): ReactElement {
  const appTheme = useAppTheme()
  const effectiveTheme: AppTheme = themeOverride === 'app' ? appTheme : themeOverride
  const workspaceRootRef = useRef(cwd)
  if (
    workspaceRootRef.current.hostId !== cwd.hostId ||
    workspaceRootRef.current.path !== cwd.path
  ) {
    workspaceRootRef.current = cwd
  }
  const workspaceRoot = workspaceRootRef.current
  const containerRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<TerminalPane | undefined>(undefined)
  const activeRef = useRef(active)
  const disconnectedRef = useRef(false)
  const restartRequestedRef = useRef(false)
  const hasStartedRef = useRef(false)
  const handlersRef = useRef({
    onTitle,
    onStatus,
    onTelemetry,
    onIdentity,
    onStarted,
    onCapabilities,
    onInput,
    onOutput,
    onBell,
    onFocus,
    onLink,
  })
  const [title, setTitle] = useState(fallbackTitle)
  const [status, setStatus] = useState('Starting…')
  const [exited, setExited] = useState(false)
  const [restartGeneration, setRestartGeneration] = useState(0)
  const launchMetadataRef = useRef({
    harnessSessionId,
    resumeOnStart,
    position,
    active,
    title,
    riskAcknowledged,
  })
  handlersRef.current = {
    onTitle,
    onStatus,
    onTelemetry,
    onIdentity,
    onStarted,
    onCapabilities,
    onInput,
    onOutput,
    onBell,
    onFocus,
    onLink,
  }
  activeRef.current = active
  launchMetadataRef.current = {
    harnessSessionId,
    resumeOnStart,
    position,
    active,
    title,
    riskAcknowledged,
  }

  useEffect(() => handlersRef.current.onTitle(title), [title])
  useEffect(() => handlersRef.current.onStatus(status), [status])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      paneRef.current?.redraw()
      paneRef.current?.focus()
      handlersRef.current.onFocus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (connectionState !== 'connected') {
      disconnectedRef.current = true
      container.replaceChildren()
      paneRef.current = undefined
      setTitle(fallbackTitle)
      setStatus(connectionState)
      handlersRef.current.onTelemetry(undefined)
      setExited(false)
      return
    }
    const isReconnect = disconnectedRef.current && hasStartedRef.current
    const isManualRestart = restartRequestedRef.current
    disconnectedRef.current = false
    restartRequestedRef.current = false
    setExited(false)
    handlersRef.current.onTelemetry(undefined)
    if (isManualRestart) setTitle(fallbackTitle)
    container.replaceChildren()
    let cancelled = false
    let ptyStarted = false
    let pendingInput = ''
    let resizeTimer: number | undefined
    let disposePane: (() => void) | undefined
    let terminalSize = { cols: 80, rows: 24 }
    let outputWriter: SynchronizedOutputWriter | undefined

    const stopData = window.hvir.on('pty:data', ({ id, data }) => {
      if (id !== sessionId) return
      handlersRef.current.onOutput()
      outputWriter?.write(data)
    })
    const stopExit = window.hvir.on('pty:exit', ({ id, exitCode }) => {
      if (id !== sessionId) return
      setStatus(`Exited (${exitCode})`)
      setExited(true)
    })
    const stopTelemetry = window.hvir.on('pty:telemetry', ({ id, telemetry }) => {
      if (id !== sessionId) return
      handlersRef.current.onTelemetry(telemetry)
    })
    const stopIdentity = window.hvir.on(
      'pty:identity',
      ({ id, harnessSessionId: identifiedId, identityStatus }) => {
        if (id !== sessionId) return
        handlersRef.current.onIdentity(identifiedId, identityStatus)
      },
    )
    void (async () => {
      try {
        // ghostty-web 0.4 cannot recolor cells already in the VT buffer. Keep one
        // canonical palette and apply the light appearance to the retained canvas;
        // this changes instantly without losing scrollback or remounting the PTY.
        const pane = await createGhosttyTerminalPane(baseTerminalTheme())
        if (cancelled) {
          pane.dispose()
          return
        }
        paneRef.current = pane
        outputWriter = new SynchronizedOutputWriter(
          (data) => pane.write(data),
          () => pane.redraw(),
        )
        const disposers = [
          pane.events.onData((data) => {
            handlersRef.current.onInput(data)
            if (ptyStarted) window.hvir.send('pty:write', { id: sessionId, data })
            else pendingInput += data
          }),
          pane.events.onResize(({ cols, rows }) => {
            terminalSize = { cols, rows }
            if (ptyStarted) {
              if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
              resizeTimer = window.setTimeout(() => {
                resizeTimer = undefined
                window.hvir.send('pty:resize', { id: sessionId, ...terminalSize })
              }, PTY_RESIZE_DEBOUNCE_MS)
            }
          }),
          pane.events.onTitle((nextTitle) => {
            setTitle(nextTitle.trim() || fallbackTitle)
          }),
          pane.events.onBell(() => handlersRef.current.onBell()),
          pane.events.onOsc((event) => console.debug('[terminal:osc]', event)),
          pane.events.onLink((target) => handlersRef.current.onLink(target)),
        ]
        disposePane = () => {
          for (const dispose of disposers) void dispose()
          pane.dispose()
        }
        pane.mount(container)
        pane.redraw()

        const metadata = launchMetadataRef.current
        if (isReconnect && supportsResume && !metadata.harnessSessionId) {
          throw new Error('Exact harness session id unavailable; start a new terminal')
        }
        const resume =
          supportsResume &&
          Boolean(metadata.harnessSessionId) &&
          (metadata.resumeOnStart || isReconnect || isManualRestart)
        const result = await window.hvir.invoke('pty:start', {
          sessionId,
          profileId,
          launchRevision,
          cwd: workspaceRoot,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
          title: metadata.title,
          position: metadata.position,
          active: metadata.active,
          resume,
          harnessSessionId: resume ? metadata.harnessSessionId : undefined,
          acknowledgeRisk: metadata.riskAcknowledged,
        })
        if (cancelled) {
          window.hvir.send('pty:kill', { id: sessionId })
          return
        }
        ptyStarted = true
        hasStartedRef.current = true
        handlersRef.current.onIdentity(result.harnessSessionId, result.identityStatus)
        handlersRef.current.onCapabilities(result.capabilities)
        handlersRef.current.onStarted()
        if (pendingInput) {
          window.hvir.send('pty:write', { id: sessionId, data: pendingInput })
          pendingInput = ''
        }
        setStatus(
          result.resumed
            ? `Resumed · pid ${result.pid}`
            : resume
              ? `New session · pid ${result.pid}`
              : isManualRestart
                ? `Restarted · pid ${result.pid}`
                : isReconnect
                  ? `New shell · pid ${result.pid}`
                  : `pid ${result.pid}`,
        )
        if (activeRef.current) {
          pane.focus()
          handlersRef.current.onFocus()
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error))
          setExited(true)
        }
      }
    })()

    return () => {
      cancelled = true
      void stopData()
      void stopExit()
      void stopTelemetry()
      void stopIdentity()
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      outputWriter?.dispose()
      outputWriter = undefined
      pendingInput = ''
      disposePane?.()
      paneRef.current = undefined
      container.replaceChildren()
      if (ptyStarted) window.hvir.send('pty:kill', { id: sessionId })
    }
  }, [
    connectionState,
    fallbackTitle,
    restartGeneration,
    sessionId,
    profileId,
    launchRevision,
    riskAcknowledged,
    supportsResume,
    workspaceRoot,
  ])

  return (
    <section
      className={`terminal-panel terminal-surface${visible ? ' visible' : ''}${active ? ' active' : ''}`}
      data-terminal-slot={slot}
      aria-label={title}
      aria-hidden={!visible}
      data-terminal-session={sessionId}
      data-terminal-status={status}
    >
      {connectionState === 'connected' && exited ? (
        <button
          type="button"
          className="terminal-restart"
          aria-label={`${supportsResume && harnessSessionId ? 'Resume' : 'Restart'} ${title}`}
          onClick={() => {
            restartRequestedRef.current = true
            setRestartGeneration((generation) => generation + 1)
          }}
        >
          {supportsResume && harnessSessionId ? 'Resume' : 'Restart'}
        </button>
      ) : null}
      <div
        key={`${workspaceRoot.hostId}:${workspaceRoot.path}:${connectionState}`}
        className="terminal-container"
        data-terminal-theme={effectiveTheme}
        ref={containerRef}
        onMouseDown={() => handlersRef.current.onFocus()}
      />
    </section>
  )
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
