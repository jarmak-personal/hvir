/** Narrow, read-only operational state surfaced by a harness adapter. */
export interface HarnessTelemetry {
  readonly contextUsedTokens: number
  /** Omitted when the harness does not expose an authoritative model window. */
  readonly contextWindowTokens?: number
  readonly contextUsedPercent?: number
}
