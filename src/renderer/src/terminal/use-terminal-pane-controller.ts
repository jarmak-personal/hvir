import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

import type { TerminalRuntimeOptions } from './terminal-runtime-options'
import { TerminalRuntimeRegistry } from './terminal-runtime-registry'

export type TerminalPaneControllerOptions = TerminalRuntimeOptions

export function useTerminalPaneController(
  options: TerminalPaneControllerOptions,
  runtimes: TerminalRuntimeRegistry,
  presented: boolean,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<ReturnType<TerminalRuntimeRegistry['acquire']> | undefined>(
    undefined,
  )
  runtimeRef.current ??= runtimes.acquire(options)
  const runtime = runtimeRef.current
  const interactions = runtime.interactions
  runtime.update(options)
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.snapshot,
    runtime.snapshot,
  )
  const paneEventSnapshot = useSyncExternalStore(
    interactions.paneEvents.subscribe,
    interactions.paneEvents.snapshot,
    interactions.paneEvents.snapshot,
  )

  useEffect(() => {
    if (!presented) return
    const container = containerRef.current
    if (!container) return
    runtime.attach(container)
    return () => runtime.detach(container)
  }, [presented, runtime])

  useLayoutEffect(
    () => runtime.synchronizeLifecycle(),
    [options.connectionState, options.presentation, runtime],
  )

  useEffect(() => {
    if (!options.active) return
    const frame = window.requestAnimationFrame(() => runtime.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [options.active, runtime])

  const getContextMenuTarget = useCallback(
    () => interactions.contextMenuTarget(),
    [interactions],
  )

  return {
    workspaceRoot: options.workspaceRoot,
    containerRef,
    ...snapshot,
    ...paneEventSnapshot,
    restart: () => runtime.restart(),
    startFresh: () => runtime.startFresh(),
    previousSemanticRegion: () => interactions.navigate('previous'),
    nextSemanticRegion: () => interactions.navigate('next'),
    searchController: interactions.search,
    openSearch: () => interactions.search.open(),
    getContextMenuTarget,
    focus: () => runtime.focus(),
  }
}
