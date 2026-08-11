interface TerminalSignalRollup {
  readonly actionable: number
  readonly working: number
}

export function workspaceActionableAttention(
  workspaceId: string,
  rollups: Readonly<Record<string, TerminalSignalRollup>>,
): number {
  return rollups[workspaceId]?.actionable ?? 0
}

export function aggregateActionableWorkspaceAttention(
  workspaceIds: readonly string[],
  rollups: Readonly<Record<string, TerminalSignalRollup>>,
): number {
  return workspaceIds.reduce(
    (total, workspaceId) => total + workspaceActionableAttention(workspaceId, rollups),
    0,
  )
}

export function workspaceWorkingTerminals(
  workspaceId: string,
  rollups: Readonly<Record<string, TerminalSignalRollup>>,
): number {
  return rollups[workspaceId]?.working ?? 0
}

export function aggregateWorkingWorkspaceTerminals(
  workspaceIds: readonly string[],
  rollups: Readonly<Record<string, TerminalSignalRollup>>,
): number {
  return workspaceIds.reduce(
    (total, workspaceId) => total + workspaceWorkingTerminals(workspaceId, rollups),
    0,
  )
}
