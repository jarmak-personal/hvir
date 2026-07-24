import { useEffect, useRef } from 'react'

import type { ProjectState } from '../../../shared'

export const NEW_WORKTREE_MOVE_BADGE_DURATION_MS = 20_000

type DismissalLease = (() => void) | 'acknowledging'

export function useNewWorktreeMoveBadge({
  projectState,
  acknowledgeWorkspaces,
  onError,
}: {
  readonly projectState?: ProjectState
  readonly acknowledgeWorkspaces: (
    projectId: string,
    workspaceIds: readonly string[],
  ) => Promise<void>
  readonly onError: (message: string) => void
}): void {
  const leases = useRef(new Map<string, DismissalLease>())
  const callbacks = useRef({ acknowledgeWorkspaces, onError })
  const generation = useRef(0)
  callbacks.current = { acknowledgeWorkspaces, onError }

  useEffect(() => {
    const current = new Set<string>()
    for (const project of projectState?.projects ?? []) {
      for (const workspace of project.workspaces) {
        if (!workspace.newlyDiscovered || workspace.missing) continue
        const key = dismissalKey(project.id, workspace.id)
        current.add(key)
        if (leases.current.has(key)) continue
        const leaseGeneration = generation.current
        const timer = window.setTimeout(() => {
          leases.current.set(key, 'acknowledging')
          void callbacks.current
            .acknowledgeWorkspaces(project.id, [workspace.id])
            .catch((reason) => {
              if (generation.current === leaseGeneration) {
                callbacks.current.onError(errorMessage(reason))
              }
            })
        }, NEW_WORKTREE_MOVE_BADGE_DURATION_MS)
        leases.current.set(key, () => window.clearTimeout(timer))
      }
    }

    for (const [key, lease] of leases.current) {
      if (current.has(key)) continue
      if (lease !== 'acknowledging') lease()
      leases.current.delete(key)
    }
  }, [projectState])

  useEffect(
    () => () => {
      generation.current += 1
      for (const lease of leases.current.values()) {
        if (lease !== 'acknowledging') lease()
      }
      leases.current.clear()
    },
    [],
  )
}

function dismissalKey(projectId: string, workspaceId: string): string {
  return `${projectId}\0${workspaceId}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
