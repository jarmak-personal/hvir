import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostConnectionState, HostPath } from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'

interface TerminalViewProps {
  readonly cwd: HostPath
  readonly connectionState: HostConnectionState
}

const OUTPUT_FLUSH_MS = 16
const MAX_BUFFERED_OUTPUT = 256 * 1024
const PTY_RESIZE_DEBOUNCE_MS = 75
const SYNC_OUTPUT_BEGIN = '\u001b[?2026h'
const SYNC_OUTPUT_END = '\u001b[?2026l'
const SYNC_OUTPUT_MAX_MS = 100

export function TerminalView({ cwd, connectionState }: TerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState('Shell')
  const [status, setStatus] = useState('Starting…')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (connectionState !== 'connected') {
      container.replaceChildren()
      setTitle('Shell')
      setStatus(connectionState)
      return
    }
    let cancelled = false
    let ptyStarted = false
    let pendingInput = ''
    let resizeTimer: number | undefined
    let disposePane: (() => void) | undefined
    let terminalSize = { cols: 80, rows: 24 }
    let bufferedOutput = ''
    let outputFrame: number | undefined
    let outputTimer: number | undefined
    let synchronizedOutput = false
    const sessionId = crypto.randomUUID()

    const clearOutputSchedule = (): void => {
      if (outputFrame !== undefined) cancelAnimationFrame(outputFrame)
      if (outputTimer !== undefined) window.clearTimeout(outputTimer)
      outputFrame = undefined
      outputTimer = undefined
    }

    const flushOutput = (): void => {
      clearOutputSchedule()
      if (!bufferedOutput) return
      const output = bufferedOutput
      bufferedOutput = ''
      synchronizedOutput = false
      paneRef?.write(output)
    }

    const scheduleOutputFlush = (synchronized = false): void => {
      if (synchronized) {
        if (outputFrame !== undefined) cancelAnimationFrame(outputFrame)
        if (outputTimer !== undefined) window.clearTimeout(outputTimer)
        outputFrame = undefined
        outputTimer = window.setTimeout(flushOutput, SYNC_OUTPUT_MAX_MS)
        return
      }
      if (outputFrame !== undefined || outputTimer !== undefined) return
      outputFrame = requestAnimationFrame(flushOutput)
      // rAF is paused for hidden/occluded windows. The timer keeps PTY output
      // moving there; the size cap below also bounds timer throttling.
      outputTimer = window.setTimeout(flushOutput, OUTPUT_FLUSH_MS)
    }

    const stopData = window.hvir.on('pty:data', ({ id, data }) => {
      if (id !== sessionId || !paneRef) return
      bufferedOutput += data
      if (bufferedOutput.includes(SYNC_OUTPUT_BEGIN)) synchronizedOutput = true
      if (synchronizedOutput) {
        if (bufferedOutput.includes(SYNC_OUTPUT_END)) flushOutput()
        else scheduleOutputFlush(true)
        return
      }
      if (bufferedOutput.length >= MAX_BUFFERED_OUTPUT) flushOutput()
      else scheduleOutputFlush()
    })
    const stopExit = window.hvir.on('pty:exit', ({ id, exitCode }) => {
      if (id === sessionId) setStatus(`Exited (${exitCode})`)
    })
    let paneRef: Awaited<ReturnType<typeof createGhosttyTerminalPane>> | undefined

    void (async () => {
      try {
        const pane = await createGhosttyTerminalPane()
        paneRef = pane
        if (cancelled) {
          pane.dispose()
          return
        }
        pane.mount(container)
        disposePane = () => pane.dispose()

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
        setStatus(`pid ${result.pid}`)
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
      clearOutputSchedule()
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      bufferedOutput = ''
      pendingInput = ''
      disposePane?.()
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
