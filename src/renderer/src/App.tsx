import { useEffect, type ReactElement } from 'react'

/**
 * Phase 1 renders an intentionally empty window (non-goal: any styling beyond
 * blank). The one thing it does is round-trip `app:info` through the typed
 * bridge, proving renderer→main IPC is wired end-to-end.
 */
export function App(): ReactElement {
  useEffect(() => {
    void window.hvir.invoke('app:info', undefined)
  }, [])

  return <></>
}
