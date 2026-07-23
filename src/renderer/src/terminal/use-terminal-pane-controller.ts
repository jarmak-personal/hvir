import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

import type { TerminalRuntimeOptions } from './terminal-runtime'
import { TerminalRuntimeRegistry } from './terminal-runtime-registry'

export type TerminalPaneControllerOptions = TerminalRuntimeOptions

export function useTerminalPaneController(
  options: TerminalPaneControllerOptions,
  runtimes: TerminalRuntimeRegistry,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const presentationRef = useRef(options.presentation)
  presentationRef.current = options.presentation
  const runtimeRef = useRef<ReturnType<TerminalRuntimeRegistry['acquire']> | undefined>(
    undefined,
  )
  runtimeRef.current ??= runtimes.acquire(options)
  const runtime = runtimeRef.current
  runtime.update(options)
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.snapshot,
    runtime.snapshot,
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Passive detach/attach ordering can overlap when a retained runtime moves
    // between workspace-owned React containers. Reassert the new owner's
    // current presentation after the old owner has detached.
    runtime.attach(container, presentationRef.current)
    return () => runtime.detach(container)
  }, [runtime])

  useLayoutEffect(
    () => runtime.synchronizeLifecycle(),
    [options.connectionState, options.presentation, runtime],
  )

  useEffect(() => {
    if (!options.active) return
    const frame = window.requestAnimationFrame(() => runtime.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [options.active, runtime])

  return {
    workspaceRoot: options.workspaceRoot,
    containerRef,
    ...snapshot,
    restart: () => runtime.restart(),
    startFresh: () => runtime.startFresh(),
    focus: () => {
      runtime.focus()
      options.onFocus()
    },
  }
}
