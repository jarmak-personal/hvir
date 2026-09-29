import { useEffect, useRef, useState } from 'react'

import type {
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
  SessionsUsageFact,
  SessionsUsageSnapshot,
} from '../../../shared'

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
    if (
      !active ||
      !rowHandle ||
      projection.status !== 'available' ||
      row?.connectionState !== 'connected'
    )
      return
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
    row?.connectionState,
  ])
  return row?.connectionState === 'connected' && usage?.handle === String(rowHandle)
    ? usage.fact
    : undefined
}
