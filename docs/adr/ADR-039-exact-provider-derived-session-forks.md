# ADR-039: Exact provider-derived session forks

## Context

hvir can start a harness conversation freshly or recover one exact registered identity. Bundled
harnesses also support deriving a new conversation from an exact existing conversation while the
source remains independently usable. Treating that transition as something to detect after it is
performed inside a terminal would require inference from terminal activity, provider artifacts,
process state, timing, or recency, none of which establishes exact intent and ownership across local
and remote hosts.

## Decision

hvir has exactly three session-start paths: a fresh launch, exact resume of an identity hvir
registered, and an exact provider-derived branch of an identity hvir registered. The derived path is
always initiated by an explicit hvir action and composed through the trusted bundled provider's own
derivation contract. Its parent identity is exact, and its child identity is either preassigned by
hvir or identified through the provider's existing exact discovery owner.

hvir never starts a session from an identity it did not register. Recency, proximity, ambient latest
state, and interactive pickers remain unavailable on every start path. hvir also never infers a
provider-side session transition from terminal input or output, screen content, artifact appearance,
process state, timing, or recency. A transition performed natively inside a harness remains native
and does not cause hvir to create or retarget a terminal.

Provider support and exact-parent admission are fail-closed. All three paths continue through the
main-owned provider registry, launch composition, PTY supervisor, and host-qualified `ProjectHost`
boundary. The source and derived sessions have independent PTY, recovery, observation, and disposal
lifecycles.

## Consequences

Users can continue two provider-owned branches without hvir reconstructing ancestry or observing
terminal content. Local and SSH launches share one authority path, and provider/version churn remains
behind the provider seam.

A derived launch is unavailable when the provider version, registered parent identity, profile
revision, host-qualified authority, or exact artifact qualification is unavailable. Provider-native
transitions performed outside hvir are intentionally not reflected in hvir's terminal topology.

## Rejected alternatives

- Detect a native transition from terminal input, output, screen cells, artifacts, processes, or
  timing: those signals cannot prove one exact hvir-owned transition across supported hosts.
- Select a recent or nearby conversation or open a provider picker: ambient selection violates exact
  recovery authority.
- Copy or parse transcript bodies to reconstruct ancestry: conversation content is unnecessary for an
  hvir-initiated provider derivation and would widen the privacy and version-compatibility boundary.
- Build a conversation graph or provider extension surface: the product requires one bounded launch
  action, not session orchestration.
