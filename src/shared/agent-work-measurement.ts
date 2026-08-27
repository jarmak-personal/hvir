/** Closed, content-free contributor-measurement vocabulary. */

import {
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_TOKEN_COUNTER_NAMES,
  type HarnessUsageCounterName,
} from './harness-usage.ts'

export const AGENT_WORK_TOKEN_COUNTER_NAMES = HARNESS_USAGE_TOKEN_COUNTER_NAMES
export type AgentWorkTokenCounterName = HarnessUsageCounterName

export const AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES =
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES

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
