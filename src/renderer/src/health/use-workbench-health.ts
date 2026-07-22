import { useCallback, useEffect, useRef, useState } from 'react'

import { isWorkbenchHealthSnapshot, type WorkbenchHealthSnapshot } from '../../../shared'

const EMPTY_HEALTH: WorkbenchHealthSnapshot = {
  version: 1,
  evidence: 'memory-only',
  items: [],
  dropped: 0,
}

export function useWorkbenchHealth(): {
  readonly ready: boolean
  readonly snapshot: WorkbenchHealthSnapshot
  readonly acknowledge: (occurrenceId: string) => void
} {
  const [snapshot, setSnapshot] = useState(EMPTY_HEALTH)
  const [ready, setReady] = useState(false)
  const eventRevision = useRef(0)

  useEffect(() => {
    let active = true
    const accept = (candidate: unknown): void => {
      if (!active || !isWorkbenchHealthSnapshot(candidate)) return
      setSnapshot(candidate)
      setReady(true)
    }
    const unsubscribe = window.hvir.on('workbench-health:state', (candidate) => {
      eventRevision.current++
      accept(candidate)
    })
    const requestedAtRevision = eventRevision.current
    void window.hvir
      .invoke('workbench-health:get', undefined)
      .then((candidate) => {
        if (eventRevision.current === requestedAtRevision) accept(candidate)
      })
      .catch(() => {
        if (active) {
          setSnapshot((current) => ({ ...current, evidence: 'unavailable' }))
          setReady(true)
        }
      })
    return () => {
      active = false
      void unsubscribe()
    }
  }, [])

  const acknowledge = useCallback((occurrenceId: string): void => {
    const requestedAtRevision = eventRevision.current
    void window.hvir
      .invoke('workbench-health:acknowledge', { occurrenceId })
      .then((candidate) => {
        if (
          eventRevision.current === requestedAtRevision &&
          isWorkbenchHealthSnapshot(candidate)
        ) {
          setSnapshot(candidate)
        }
      })
      .catch(() => {
        if (eventRevision.current === requestedAtRevision) {
          setSnapshot((current) => ({ ...current, evidence: 'unavailable' }))
        }
      })
  }, [])

  return { ready, snapshot, acknowledge }
}
