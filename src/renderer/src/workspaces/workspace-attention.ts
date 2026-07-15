interface AttentionRollup {
  readonly unseen: number
  readonly actionable: number
}

export function aggregateWorkspaceAttention(
  workspaceIds: readonly string[],
  rollups: Readonly<Record<string, AttentionRollup>>,
): AttentionRollup {
  return workspaceIds.reduce<AttentionRollup>(
    (total, workspaceId) => ({
      unseen: total.unseen + (rollups[workspaceId]?.unseen ?? 0),
      actionable: total.actionable + (rollups[workspaceId]?.actionable ?? 0),
    }),
    { unseen: 0, actionable: 0 },
  )
}
