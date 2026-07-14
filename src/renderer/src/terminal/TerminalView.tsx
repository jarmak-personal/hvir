import { useEffect, useRef, useState, type ReactElement } from 'react'

import type {
  HarnessTelemetry,
  HostConnectionState,
  HostPath,
  TerminalAdapterId,
  TerminalIdentityStatus,
} from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import { SynchronizedOutputWriter } from './synchronized-output'
import type { TerminalPane } from './terminal-pane'

interface TerminalViewProps {
  readonly sessionId: string
  readonly adapterId: TerminalAdapterId
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly resumeOnStart: boolean
  readonly position: number
  readonly active: boolean
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
  readonly onOutput: () => void
  readonly onBell: () => void
  readonly onFocus: () => void
}

const PTY_RESIZE_DEBOUNCE_MS = 75

export function TerminalView({
  sessionId,
  adapterId,
  fallbackTitle,
  harnessSessionId,
  resumeOnStart,
  position,
  active,
  cwd,
  connectionState,
  onTitle,
  onStatus,
  onTelemetry,
  onIdentity,
  onStarted,
  onOutput,
  onBell,
  onFocus,
}: TerminalViewProps): ReactElement {
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
    onOutput,
    onBell,
    onFocus,
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
  })
  handlersRef.current = {
    onTitle,
    onStatus,
    onTelemetry,
    onIdentity,
    onStarted,
    onOutput,
    onBell,
    onFocus,
  }
  activeRef.current = active
  launchMetadataRef.current = {
    harnessSessionId,
    resumeOnStart,
    position,
    active,
    title,
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
        const pane = await createGhosttyTerminalPane()
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
        ]
        disposePane = () => {
          for (const dispose of disposers) void dispose()
          pane.dispose()
        }
        pane.mount(container)
        pane.redraw()

        const metadata = launchMetadataRef.current
        if (isReconnect && adapterId !== 'plain-shell' && !metadata.harnessSessionId) {
          throw new Error('Exact harness session id unavailable; start a new terminal')
        }
        const resume =
          adapterId !== 'plain-shell' &&
          Boolean(metadata.harnessSessionId) &&
          (metadata.resumeOnStart || isReconnect || isManualRestart)
        const result = await window.hvir.invoke('pty:start', {
          sessionId,
          adapterId,
          cwd,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
          title: metadata.title,
          position: metadata.position,
          active: metadata.active,
          resume,
          harnessSessionId: resume ? metadata.harnessSessionId : undefined,
        })
        if (cancelled) {
          window.hvir.send('pty:kill', { id: sessionId })
          return
        }
        ptyStarted = true
        hasStartedRef.current = true
        handlersRef.current.onIdentity(result.harnessSessionId, result.identityStatus)
        handlersRef.current.onStarted()
        if (pendingInput) {
          window.hvir.send('pty:write', { id: sessionId, data: pendingInput })
          pendingInput = ''
        }
        setStatus(
          resume
            ? `Resumed · pid ${result.pid}`
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
  }, [adapterId, connectionState, cwd, fallbackTitle, restartGeneration, sessionId])

  return (
    <section
      className={`terminal-panel terminal-surface${active ? ' active' : ''}`}
      aria-label={title}
      aria-hidden={!active}
      data-terminal-session={sessionId}
    >
      <header className="panel-header">
        <span className="terminal-panel-title">{title}</span>
        <span className="terminal-status">
          <span className="panel-meta">{status}</span>
          {connectionState === 'connected' && exited ? (
            <button
              type="button"
              className="terminal-restart"
              onClick={() => {
                restartRequestedRef.current = true
                setRestartGeneration((generation) => generation + 1)
              }}
            >
              {adapterId !== 'plain-shell' && harnessSessionId ? 'Resume' : 'Restart'}
            </button>
          ) : null}
        </span>
      </header>
      <div
        key={`${cwd.hostId}:${cwd.path}:${connectionState}`}
        className="terminal-container"
        ref={containerRef}
        onMouseDown={() => handlersRef.current.onFocus()}
      />
    </section>
  )
}
