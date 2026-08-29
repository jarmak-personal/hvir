/** Provider-neutral cumulative token-usage vocabulary. */

export const HARNESS_USAGE_TOKEN_COUNTER_NAMES = [
  'freshInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
] as const

export type HarnessUsageCounterName = (typeof HARNESS_USAGE_TOKEN_COUNTER_NAMES)[number]

export const HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES = [
  HARNESS_USAGE_TOKEN_COUNTER_NAMES[0],
  HARNESS_USAGE_TOKEN_COUNTER_NAMES[1],
  HARNESS_USAGE_TOKEN_COUNTER_NAMES[2],
  HARNESS_USAGE_TOKEN_COUNTER_NAMES[3],
] as const

export type HarnessUsageCounters = Readonly<
  Partial<Record<HarnessUsageCounterName, number>>
>

export interface HarnessUsageValue extends HarnessUsageCounters {
  /** Present only when every additive category has an exact safe-integer value. */
  readonly normalizedTokenTotal?: number
}
