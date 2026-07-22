import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

import type { TerminalRuntimeOptions } from './terminal-runtime'
import { TerminalRuntimeRegistry } from './terminal-runtime-registry'

export type TerminalPaneControllerOptions = TerminalRuntimeOptions

export function useTerminalPaneController(
  options: TerminalPaneControllerOptions,
  runtimes: TerminalRuntimeRegistry,
) {
  const containerRef = useRef<HTMLDivElement>(null)
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
    runtime.attach(container)
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
    focus: () => options.onFocus(),
  }
}
