export type TerminalAttention = 'output' | 'bell' | 'idle'

const attentionPriority: Record<TerminalAttention, number> = {
  output: 1,
  bell: 2,
  idle: 3,
}

export function nextTerminalAttention(
  current: TerminalAttention | undefined,
  incoming: TerminalAttention,
  focused: boolean,
): TerminalAttention | undefined {
  if (focused) return undefined
  if (current && attentionPriority[current] >= attentionPriority[incoming]) {
    return current
  }
  return incoming
}

export function terminalAttentionLabel(attention: TerminalAttention): string {
  if (attention === 'idle') return 'Ready'
  if (attention === 'bell') return 'Bell'
  return 'New output'
}

export function terminalAttentionRollup(
  attentions: readonly (TerminalAttention | undefined)[],
): { readonly unseen: number; readonly actionable: number } {
  return {
    unseen: attentions.filter(Boolean).length,
    actionable: attentions.filter(
      (attention) => attention === 'idle' || attention === 'bell',
    ).length,
  }
}
