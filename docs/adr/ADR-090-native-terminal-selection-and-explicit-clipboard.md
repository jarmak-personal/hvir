# ADR-090: Native terminal selection and explicit clipboard

> Lifecycle: Active

## Context

[ADR-086](ADR-086-native-terminal-state-and-presentation.md) separates the native
parser from its presentation. The renderer therefore cannot synchronously read selected
text from a local terminal object. A frame acquired in main is not proof that the
receiver drew it. A tracked native pin can survive scrolling, but does not certify
unchanged content during a multi-step read.

Selection, explicit clipboard actions and link gestures must retain the existing PTY,
provider, host and navigation owners. They must also remain usable while unrelated
terminal output continues. Terminal-related decisions remain reviewable.

## Decision

Reuse the authoritative Surface's mature selection gesture, tracked selections and
formatter. Native state owns word/line/rectangular selection, repeated clicks, viewport
autoscroll, application mouse arbitration and highlight. Restricted external pointer
input selects locally only when native reporting/modifier policy permits it. It does
not invoke ambient application bindings, prompt clicks, copy-on-select or native openers.
Readonly state permits selection and navigation while suppressing PTY reporting/writes.
Primary clipboard and middle-click paste do not become available merely because a
native default supports them.

Gestures address the current native viewport at dispatch, matching the native Surface's
current-content semantics. A successful receiver draw qualifies the current attachment,
screen and applied geometry, not historic text or physical presentation. Main derives
the private selection context from that observation and current view authority. Native
selection does not demand the newest parser mutation or global output quiescence.
Gesture anchors and selection identity remain distinct from authenticated retained
semantic/search occurrences.

One DOM pointer transaction retains delivery across an asynchronous native press
acknowledgement. Scoped temporary outside-pointer routing enters the existing input FIFO
and prevents a second pane from consuming the same gesture. Native disposition still
controls normal pointer capture. Revocation removes routing and sends captured native
cleanup even for a readonly drag without keyboard focus; cleanup retains selected text.

Expose narrow asynchronous selection/menu capabilities instead of a synchronous selected
text cache or full transcript. Existing menu request identity and pane ownership remain
revocable. Plain Ctrl+C remains terminal input; the existing explicit copy shortcuts
retain their intent. Copy capture is ordered after earlier gestures in the existing DOM
input FIFO and waits for definitive native begin acknowledgement. Productive extraction
then runs outside that FIFO through separately admitted native steps. Typing and cleanup
can proceed, and selection-affecting changes can truthfully invalidate the copy.

An exact read linearizes at native begin. Its owned tracked range, screen generation,
selection identity and applied geometry qualify later steps. A request-owned sparse row
write/read set detects changes both before and after a row is read. Native mutation
owners record affected old and new identities before text, formatting-wrap, relocation,
reuse or layout changes. A captured row changing latches stale; a not-yet-read row is
marked modified and cannot later be accepted as begin-time content. Unrelated rows do
not invalidate stable selected rows, including rows on the same page.

Begin captures the PageList's next-generation cutoff and allocated backing size in
constant work. Only pre-begin generations may enter the sparse set; post-begin rows are
refused. Existing page row capacity bounds metadata, including unused capacity, without
an initial range scan or a selected-text source ceiling. Old identities are handled
before generation replacement. Allocation refusal invalidates the read without failing
the parser. Finish checks sticky state and identity without rescanning the entire range.
Collection growth is not assumed constant work.

The resumable plain formatter preserves mature Unicode, wide-cell, grapheme, whitespace,
soft-wrap and rectangle rules. Each step bounds bytes and cell/codepoint/whitespace work;
transport chunks are not a total-copy limit. An incomplete write is not a safe formatter
resume point. Cancellation closes the exact cursor, including acquisition whose logical
caller disappeared before receiving its physical result. Finish closes its cursor on
every outcome. An abandoned begin may expire; productive copy has no fixed total-duration
ceiling. Per-step timeouts and unknown physical completion retain their existing meaning.

After successful extraction, revalidate the exact source, owner, immutable instance,
view and request immediately before invoking the existing clipboard call. This does not
promise that source state remains latest until an OS promise settles. No selection is a
silent no-op. Cancellation and stale results cannot clear the clipboard or copy from a
replacement pane. Existing explicit text/file paste and provider-approved image staging
keep their complete payload, fallback, destination and host-qualified cleanup owners.
OSC52 limits do not govern explicit copy or ordinary paste.

Link activation is explicit and host-correct. One current-native command resolves OSC8
or captures the current physical row, preserving user selection. A native byte offset
maps the clicked cell, including wide/combining characters, to the bounded formatter
result. Existing pure file/loopback policy and the pinned licensed HTTP(S) detector
classify that result. There is no new regex parser, hover poll, transcript mirror or
native OS opener. Row continuation runs outside the input FIFO, and a busy read does
not replace an independent copy. Current source authority is checked before existing
typed navigation or the trusted workbench external-window route.

## Consequences

Exact copy is an asynchronous native resource operation. Clear/reset, overwrite,
eviction, reflow, owner changes and disposal have explicit refusal and cleanup outcomes.
Native mutation coverage and resumable formatting are maintained upstream responsibilities;
pins, dirty flags and allocation generations alone cannot substitute for their proof.

Main and renderer keep product authority while bounded native work remains off their UI
loops. Real browser clipboard invocation, OS clipboard commit, successful canvas draw
and physical presentation are separate observations. Current-viewport gesture semantics
do not authenticate an old displayed text snapshot.

## Rejected alternatives

- A second parser, selected-text cache or renderer transcript to preserve synchronous APIs.
- Requiring the newest parser mutation for every gesture or invalidating copy on unrelated
  output: both can prevent interaction under continuing output.
- Retained frame history to promise stronger historical click semantics than the native
  Surface provides.
- A whole-selection allocation under one native lock, or an unbounded final consistency scan.
- Treating dirty flags, row IDs or a second read pass as overwrite-proof identity.
- Holding the browser input FIFO for a complete large extraction, or releasing it before
  native capture is acknowledged.
- Ambient native clipboard/navigation actions or a new explicit-copy/paste source ceiling.
