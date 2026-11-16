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
  const attachedContainer = useRef<HTMLDivElement | null>(null)
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

  const containerRef = useCallback(
    (container: HTMLDivElement | null) => {
      const previous = attachedContainer.current
      if (previous === container) return
      if (previous) runtime.detach(previous)
      attachedContainer.current = container
      if (container && presented) runtime.attach(container)
    },
    [presented, runtime],
  )

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
    live: runtime.live,
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
