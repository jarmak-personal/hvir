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
        if (existing?.actionable === rollup.actionable) {
          return current
        }
        return { ...current, [workspaceId]: rollup }
      })
    },
    [],
  )

  useEffect(() => {
    const actionable = Object.values(rollups).reduce(
      (total, rollup) => total + rollup.actionable,
      0,
    )
    window.hvir.send('app:attention', { count: actionable })
  }, [rollups])
  useEffect(() => () => window.hvir.send('app:attention', { count: 0 }), [])

  return { rollups, updateRollup }
}
