import { useCallback, useEffect, useState } from 'react'

import type {
  WorkspaceAttentionRollup,
  WorkspaceAttentionRollups,
} from '../workspaces/project-session-model'

export function useTerminalAttention() {
  const [rollups, setRollups] = useState<WorkspaceAttentionRollups>({})
  const updateRollup = useCallback(
    (workspaceId: string, rollup: WorkspaceAttentionRollup): void => {
      setRollups((current) => {
        const existing = current[workspaceId]
        if (
          existing?.actionable === rollup.actionable &&
          existing.working === rollup.working
        ) {
          return current
        }
        return { ...current, [workspaceId]: rollup }
      })
    },
    [],
  )
  const actionable = Object.values(rollups).reduce(
    (total, rollup) => total + rollup.actionable,
    0,
  )

  useEffect(() => {
    window.hvir.send('app:attention', { count: actionable })
  }, [actionable])
  useEffect(() => () => window.hvir.send('app:attention', { count: 0 }), [])

  return { rollups, updateRollup }
}
