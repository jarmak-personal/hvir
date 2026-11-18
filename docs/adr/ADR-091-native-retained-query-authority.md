# ADR-091: Native retained query authority

> Lifecycle: Partially superseded
> Superseded by: [ADR-094](ADR-094-current-buffer-native-search.md) | partial | Search source selection and query lifetime across normal/alternate screen transitions.

## Context

[ADR-086](ADR-086-native-terminal-state-and-presentation.md) assigns terminal state
to the native Surface. Search and semantic navigation therefore cannot depend on a
renderer transcript or synchronous parser access. Native search defaults and public
whole-result APIs do not provide the existing normal-buffer ordering, live identity,
bounded scheduling or exact extraction contract.

A retained match identifies particular content. A parser-origin semantic boundary
identifies a retained logical position whose current body can continue to grow or
change. Neither coordinates nor a relocated tracked pin alone establish both meanings.

## Decision

Keep one retained-query owner beside the Surface's existing external operations,
using the same Terminal and mutex. Extend the mature native search and plain formatter
owners with bounded continuations. Query preparation, formatting, comparisons,
reconciliation, result storage and range validation must account for actual work;
returning a limited number of results does not make an unbounded scan acceptable.
Worker jobs yield between native steps without holding the browser input FIFO.

Search the retained normal buffer, including while the alternate screen is presented.
Match literal UTF-8 text with explicit case sensitivity or ASCII-only insensitive
comparison. Preserve overlapping matches, oldest-row then left-to-right order, exact
hard-break versus soft-wrap behavior and the existing query-specific admission bound.
There is no new total history, match-count, text-source or productive-copy ceiling.

Native query state owns result metadata and count. Expose asynchronous count/status
updates, indexed result access and opaque occurrence handles through a narrow pane
capability. The renderer retains presentation state and the current occurrence rather
than materializing the complete native result set. Existing controllers own initial
selection, wrapping navigation, highlights and clipboard intent. Streaming updates
refresh counts and the selected occurrence's current index without revealing again.
Alternate-screen reveal refusal does not revoke a valid normal-buffer occurrence.

Authenticate search occurrences with native page generations and exact affected-cell
write identity. A terminal write serial and live-page cell stamps distinguish an
untouched match from an identical rewrite, including writes elsewhere on the same
row. Sidecar metadata is bounded by actual allocated native page capacity, not by an
unbounded write journal or one tracked pin per match. Mutation hooks precede the
actual write; relocation, reuse and layout changes must move identity with content or
explicitly revoke it. Every covered cell is validated through bounded continuation.

Install request-owned mutation protection before multi-step validation or extraction.
A write before a cell is validated cannot be accepted as prior content; a write after
validation latches failure. Finish certifies sticky state without an unbounded second
pass. Reuse the explicit read lifecycle from
[ADR-090](ADR-090-native-terminal-selection-and-explicit-clipboard.md): admission,
targeted cancellation, physical cleanup, bounded Next and certified Finish. A busy
cursor does not replace another request's read or mutate user selection.

Create semantic boundary authority at the genuine native semantic parser transition.
Copied effects carry that opaque authority with observed coordinates; draining an
effect later cannot manufacture it. A boundary follows a retained logical location,
survives ordinary population and body rewrites, and is revoked by eviction, reset,
reflow or owner loss as appropriate. It is not a historical search-match cutoff.
Existing bounded semantic metadata, transition policy and same-screen navigation
remain in their feature owner. Gaps revoke incomplete provenance explicitly.

Semantic copy captures a closed range, or the current end of an open region, at the
command boundary. It reads that range's current half-open body with the same bounded
mutation protection. Native inclusive selections are adapted deliberately; wide,
combining, blank and wrapped cells retain the mature formatter's exact text behavior.
Reveal and extraction preserve user selection and do not write to the PTY.

Only the selected occurrence owns a native highlight. A validated resolve may refresh
its bounded native highlight snapshot after retained content moves, without scrolling
or promoting another occurrence. Query, occurrence and highlight-generation checks at
commit prevent a delayed refresh from undoing clear or replacement. An admitted
highlight-only update uses the existing native mutation/application fence, with
`revealed: false`; pure lookup remains non-mutating. This certifies native application,
not physical presentation, which remains a separate rendered observation.

Pane, query, occurrence and request lifetimes remain distinct. Query replacement,
reflow, revocation and disposal cancel owned work; late completion cannot revive a
highlight or affect a replacement owner. Revalidate current intent immediately before
clipboard invocation, without requiring unrelated output or the latest frame to stop.

## Consequences

Search and semantic consumers use asynchronous capabilities instead of assuming a
renderer parser. Native result metadata can scale with retained matches while each
operation and transferred page remains bounded. Exact cell identity adds native
metadata and mutation coverage responsibilities; dirty flags and text equality cannot
substitute for those responsibilities.

Semantic boundaries intentionally describe current retained regions rather than
immutable historical bodies. Command-time reads and historical matches therefore have
different authentication rules, with the same explicit stale/foreign refusal and
cleanup discipline at their resource boundary.

## Rejected alternatives

- A second terminal parser, transcript mirror, renderer-wide result snapshot or text cache.
- Native active-screen/newest-first defaults that silently change existing search behavior.
- Whole-row revisions that revoke an untouched match after an unrelated suffix write.
- Per-match pins, unbounded mutation journals or hashes treated as occurrence identity.
- Applying historical match cutoffs to semantic markers before their bodies are populated.
- Completion-only counts, arbitrary result/source caps, unbounded final validation or
  waiting for output quiescence to make live queries appear safe.
