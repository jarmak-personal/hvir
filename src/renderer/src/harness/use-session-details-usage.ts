import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type {
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
  SessionsUsageFact,
  SessionsUsageSnapshot,
} from '../../../shared'
import type { SessionsProjectionCoordinator } from '../sessions/sessions-projection-coordinator'

const INACTIVE_PROJECTION: SessionsProjectionSnapshot = {
  version: 1,
  demandGeneration: 0,
  revision: 0,
  sourceRevision: 0,
  status: 'inactive',
  rows: [],
}
const EMPTY_SUBSCRIPTION = (): (() => void) => () => undefined
const INACTIVE_SNAPSHOT = (): SessionsProjectionSnapshot => INACTIVE_PROJECTION

let nextDemandGeneration = 10_000

function demandGeneration(): number {
  nextDemandGeneration =
    nextDemandGeneration >= Number.MAX_SAFE_INTEGER ? 10_000 : nextDemandGeneration + 1
  return nextDemandGeneration
}

/** Usage lease over the already-current global Sessions projection. */
export function useSessionsDetailsUsage(
  row: SessionsProjectionRow | undefined,
  projection: SessionsProjectionSnapshot,
  active: boolean,
): SessionsUsageFact | undefined {
  const [usage, setUsage] = useState<{
    readonly handle: string
    readonly fact: SessionsUsageFact
  }>()
  const epoch = useRef(0)
  const rowHandle = row?.handle
  const livePtyHandle = row?.livePty?.handle
  const livePtyOwner = row?.livePty?.rendererOwnerId
  const livePtyGeneration = row?.livePty?.rendererGeneration
  useEffect(() => {
    setUsage(undefined)
    if (!active || !rowHandle || projection.status !== 'available') return
    const demand = demandGeneration()
    const currentEpoch = ++epoch.current
    let stopped = false
    const accept = (snapshot: SessionsUsageSnapshot): void => {
      if (
        stopped ||
        epoch.current !== currentEpoch ||
        snapshot.demandGeneration !== demand
      )
        return
      const fact = snapshot.rows.find(
        (candidate) => candidate.handle === rowHandle,
      )?.usage
      if (fact) setUsage({ handle: String(rowHandle), fact })
    }
    const unsubscribe = window.hvir.on('sessions:usage-changed', (change) => {
      if (change.demandGeneration !== demand || stopped) return
      void window.hvir
        .invoke('sessions:usage-snapshot', { demandGeneration: demand })
        .then(accept, () => undefined)
    })
    void window.hvir
      .invoke('sessions:usage-observe', {
        demandGeneration: demand,
        projectionDemandGeneration: projection.demandGeneration,
        sourceRevision: projection.sourceRevision,
        targets: [
          {
            handle: rowHandle,
            livePty:
              livePtyHandle &&
              livePtyOwner !== undefined &&
              livePtyGeneration !== undefined
                ? {
                    handle: livePtyHandle,
                    rendererOwnerId: livePtyOwner,
                    rendererGeneration: livePtyGeneration,
                  }
                : undefined,
          },
        ],
      })
      .then(accept, () => {
        if (!stopped)
          setUsage({
            handle: String(rowHandle),
            fact: { status: 'unavailable', reason: 'source-unavailable' },
          })
      })
    return () => {
      stopped = true
      epoch.current += 1
      void unsubscribe()
      void window.hvir.invoke('sessions:usage-release', { demandGeneration: demand })
    }
  }, [
    active,
    projection.demandGeneration,
    projection.sourceRevision,
    projection.status,
    livePtyGeneration,
    livePtyHandle,
    livePtyOwner,
    rowHandle,
  ])
  return usage && usage.handle === String(rowHandle) ? usage.fact : undefined
}

/**
 * Terminal-rail usage borrows the read-only Sessions qualification only while
 * one details popover is visible. It creates no session, workspace, host, or PTY.
 */
export function useTerminalDetailsUsage(
  terminalId: string | undefined,
  active: boolean,
  source?: SessionsProjectionCoordinator,
): SessionsUsageFact | undefined {
  const projection = useSyncExternalStore(
    source?.subscribe ?? EMPTY_SUBSCRIPTION,
    source?.snapshot ?? INACTIVE_SNAPSHOT,
    source?.snapshot ?? INACTIVE_SNAPSHOT,
  )
  const row =
    projection.status === 'available'
      ? projection.rows.find((candidate) => String(candidate.handle) === terminalId)
      : undefined
  const usage = useSessionsDetailsUsage(row, projection, active && source !== undefined)
  useEffect(() => {
    if (active && terminalId && source) return source.acquire()
  }, [active, source, terminalId])
  return usage
}

export function useApplicationFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const focus = (): void => setFocused(true)
    const blur = (): void => setFocused(false)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return focused
}
