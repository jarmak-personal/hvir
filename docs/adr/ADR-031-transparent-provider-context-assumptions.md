# ADR-031: Transparent provider context assumptions

> Lifecycle: Active
> Supersedes: [ADR-006](ADR-006-exact-harness-recovery.md) | partial | Requiring an authoritative context window for pressure presentation and one universal threshold pair.

## Context

Harnesses do not expose context capacity uniformly. Claude Code transcripts provide measured
token counts without an authoritative context window, so ADR-006 requires hvir to show a neutral
count. That truthful fallback cannot communicate context pressure even when hvir has accepted a
stable provider-level capacity assumption.

Pressure also has different practical meaning across harnesses. One universal warning and
critical threshold cannot express a deliberately more cautious provider policy without making the
renderer identify providers or hiding the policy in presentation code.

## Decision

A trusted bundled harness provider may declare a fixed assumed context window and pressure
thresholds in its bounded, serializable capability descriptor. The provider owns the values; the
renderer applies the generic policy without branching on provider identity. An assumed window is
visibly identified as assumed wherever the meter describes its capacity.

Claude Code declares a 1,000,000-token assumed window, warning pressure at 20% used, and critical
pressure at 40% used. The assumption applies uniformly to Claude Code telemetry rather than being
selected from model names. Measured token counts remain transcript-owned.

Codex continues to use its reported context window and the existing default warning and critical
thresholds of 40% and 70%. A reported telemetry window takes precedence over any provider fallback.

This supersedes ADR-006 only where that record requires an authoritative window for pressure
presentation and fixes one universal threshold pair. Screen parsing, model-specific lookup tables,
and inferred per-model capacities remain prohibited telemetry sources.

## Consequences

Claude context pressure becomes visible and intentionally cautious while the renderer stays
provider-neutral. The catalog contract grows one optional data-only policy, with no new process,
observer, persistence, or host lifecycle.

The fixed capacity may diverge from future Claude Code behavior. Its visible assumed status avoids
claiming provider authority; changing or removing it requires revisiting the bundled provider
policy rather than silently deriving a value from model output.

## Rejected alternatives

- Continue showing only a count for Claude; this preserves the prior rule but withholds the desired
  pressure signal.
- Key context capacity by Claude model name; this recreates the model lookup table prohibited by
  ADR-006 and becomes stale as provider models evolve.
- Branch on `claude-code` inside the renderer; this leaks harness-specific behavior past the
  provider catalog seam.
- Change the global thresholds to 20% and 40%; this would alter Codex behavior without a product
  requirement.
