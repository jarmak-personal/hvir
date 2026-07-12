import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import { createGhosttyTerminalPane } from './ghostty-terminal-pane'

interface TerminalViewProps {
  readonly cwd: HostPath
}

const OUTPUT_FLUSH_MS = 16
const MAX_BUFFERED_OUTPUT = 256 * 1024

export function TerminalView({ cwd }: TerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState('Shell')
  const [status, setStatus] = useState('Starting…')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let ptyStarted = false
    let disposePane: (() => void) | undefined
    let terminalSize = { cols: 80, rows: 24 }
    let bufferedOutput = ''
    let outputFrame: number | undefined
    let outputTimer: number | undefined
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
      paneRef?.write(output)
    }

    const scheduleOutputFlush = (): void => {
      outputFrame = requestAnimationFrame(flushOutput)
      // rAF is paused for hidden/occluded windows. The timer keeps PTY output
      // moving there; the size cap below also bounds timer throttling.
      outputTimer = window.setTimeout(flushOutput, OUTPUT_FLUSH_MS)
    }

    const stopData = window.hvir.on('pty:data', ({ id, data }) => {
      if (id !== sessionId || !paneRef) return
      if (outputFrame === undefined && outputTimer === undefined) {
        // Preserve prompt/typing latency for the first chunk, then coalesce a
        // sustained burst to at most one Ghostty write per frame/timer window.
        paneRef.write(data)
        scheduleOutputFlush()
      } else {
        bufferedOutput += data
        if (bufferedOutput.length >= MAX_BUFFERED_OUTPUT) flushOutput()
      }
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
            window.hvir.send('pty:write', { id: sessionId, data })
          }),
          pane.events.onResize(({ cols, rows }) => {
            terminalSize = { cols, rows }
            if (ptyStarted) {
              window.hvir.send('pty:resize', { id: sessionId, cols, rows })
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
        ptyStarted = true
        if (cancelled) {
          window.hvir.send('pty:kill', { id: sessionId })
          return
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
      bufferedOutput = ''
      disposePane?.()
      if (ptyStarted) window.hvir.send('pty:kill', { id: sessionId })
    }
  }, [cwd])

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
