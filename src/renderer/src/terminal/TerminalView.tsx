import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostConnectionState, HostPath } from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import { SynchronizedOutputWriter } from './synchronized-output'

interface TerminalViewProps {
  readonly cwd: HostPath
  readonly connectionState: HostConnectionState
}

const PTY_RESIZE_DEBOUNCE_MS = 75

export function TerminalView({ cwd, connectionState }: TerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const disconnectedRef = useRef(false)
  const [title, setTitle] = useState('Shell')
  const [status, setStatus] = useState('Starting…')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (connectionState !== 'connected') {
      disconnectedRef.current = true
      container.replaceChildren()
      setTitle('Shell')
      setStatus(connectionState)
      return
    }
    const isReconnect = disconnectedRef.current
    disconnectedRef.current = false
    // A newly connected host always gets a new PTY. Remove the old render
    // surface before Ghostty initializes so a GPU-backed canvas cannot remain
    // visible as fake scrollback from the ended session.
    container.replaceChildren()
    let cancelled = false
    let ptyStarted = false
    let pendingInput = ''
    let resizeTimer: number | undefined
    let disposePane: (() => void) | undefined
    let terminalSize = { cols: 80, rows: 24 }
    let outputWriter: SynchronizedOutputWriter | undefined
    const sessionId = crypto.randomUUID()

    const stopData = window.hvir.on('pty:data', ({ id, data }) => {
      if (id === sessionId) outputWriter?.write(data)
    })
    const stopExit = window.hvir.on('pty:exit', ({ id, exitCode }) => {
      if (id === sessionId) setStatus(`Exited (${exitCode})`)
    })
    void (async () => {
      try {
        const pane = await createGhosttyTerminalPane()
        if (cancelled) {
          pane.dispose()
          return
        }
        outputWriter = new SynchronizedOutputWriter(
          (data) => pane.write(data),
          () => pane.redraw(),
        )
        // Subscribe before mount: FitAddon emits the initial grid size during
        // mount. Missing that event starts every PTY at the 80x24 fallback until
        // the user resizes, which breaks full-screen TUIs such as Codex.
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
            setTitle(nextTitle || 'Shell')
            console.debug('[terminal:title]', nextTitle)
          }),
          pane.events.onBell(() => console.debug('[terminal:bell]')),
          pane.events.onOsc((event) => console.debug('[terminal:osc]', event)),
        ]
        disposePane = () => {
          for (const dispose of disposers) void dispose()
          pane.dispose()
        }
        pane.mount(container)
        pane.redraw()

        const result = await window.hvir.invoke('pty:start', {
          sessionId,
          cwd,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
        })
        if (cancelled) {
          window.hvir.send('pty:kill', { id: sessionId })
          return
        }
        ptyStarted = true
        if (pendingInput) {
          window.hvir.send('pty:write', { id: sessionId, data: pendingInput })
          pendingInput = ''
        }
        setStatus(isReconnect ? `New shell · pid ${result.pid}` : `pid ${result.pid}`)
        pane.focus()
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error))
        }
      }
    })()

    return () => {
      cancelled = true
      void stopData()
      void stopExit()
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      outputWriter?.dispose()
      outputWriter = undefined
      pendingInput = ''
      disposePane?.()
      container.replaceChildren()
      if (ptyStarted) window.hvir.send('pty:kill', { id: sessionId })
    }
  }, [connectionState, cwd])

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <header className="panel-header">
        <span>{title}</span>
        <span className="panel-meta">{status}</span>
      </header>
      <div className="terminal-container" ref={containerRef} />
    </section>
  )
}
