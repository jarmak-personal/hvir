interface AttentionRollup {
  readonly actionable: number
}

export function workspaceActionableAttention(
  workspaceId: string,
  rollups: Readonly<Record<string, AttentionRollup>>,
): number {
  return rollups[workspaceId]?.actionable ?? 0
}

export function aggregateActionableWorkspaceAttention(
  workspaceIds: readonly string[],
  rollups: Readonly<Record<string, AttentionRollup>>,
): number {
  return workspaceIds.reduce(
    (total, workspaceId) => total + workspaceActionableAttention(workspaceId, rollups),
    0,
  )
}
