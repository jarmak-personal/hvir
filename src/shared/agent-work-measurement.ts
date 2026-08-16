/** Closed, content-free measurement vocabulary shared by providers and repository tooling. */

export const AGENT_WORK_TOKEN_COUNTER_NAMES = [
  'freshInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
] as const
export type AgentWorkTokenCounterName = (typeof AGENT_WORK_TOKEN_COUNTER_NAMES)[number]

export const AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES = [
  AGENT_WORK_TOKEN_COUNTER_NAMES[0],
  AGENT_WORK_TOKEN_COUNTER_NAMES[1],
  AGENT_WORK_TOKEN_COUNTER_NAMES[2],
  AGENT_WORK_TOKEN_COUNTER_NAMES[3],
] as const

export const HARNESS_USAGE_UNAVAILABLE_REASONS = [
  'invalid-session-identity',
  'artifact-unavailable',
  'artifact-too-large',
  'usage-unavailable',
] as const
export type HarnessUsageUnavailableReason =
  (typeof HARNESS_USAGE_UNAVAILABLE_REASONS)[number]

export const HARNESS_USAGE_DELTA_UNAVAILABLE_REASONS = [
  'snapshot-unavailable',
  'provider-mismatch',
  'observation-order-invalid',
  'counter-reset',
  'counters-unavailable',
] as const
export type HarnessUsageDeltaUnavailableReason =
  (typeof HARNESS_USAGE_DELTA_UNAVAILABLE_REASONS)[number]

export const AGENT_WORK_UNAVAILABLE_REASONS = [
  'unsupported-telemetry',
  'run-identity-unproven',
  ...HARNESS_USAGE_UNAVAILABLE_REASONS,
  ...HARNESS_USAGE_DELTA_UNAVAILABLE_REASONS,
] as const
export type AgentWorkUnavailableReason = (typeof AGENT_WORK_UNAVAILABLE_REASONS)[number]
