# ADR-016: Bounded local runtime diagnostics

## Context

hvir already contains several distinct fault surfaces. React contains render failures, the
window manager observes renderer load, exit, and responsiveness, web panes retain bounded
pane diagnostics, and feature models present expected filesystem, Git, host, and profile
failures. Packaged launches nevertheless discard standard output, so some high-confidence
failures and recovery outcomes leave no durable, user-reviewable evidence.

A blanket error, rejection, console, or IPC recorder would reverse existing ownership and
capture sensitive content. IPC carries file writes, authentication answers, profile values,
and terminal input; rendered surfaces can contain source, transcripts, credentials, and
hostile web content. Diagnostics must also obey the promise that nothing blocks paint and
must not turn ADR-009 terminal attention into a general notification system.

## Decision

### Fault meaning and ownership

A **silent fault** is a product invariant violation that has no durable or user-visible
indication after its current recovery path finishes. It is not merely an event absent from a
global journal. A console message is not user-visible, while an expected failure rendered by
its owning feature is not silent merely because it is absent from the journal.

Observations have three classes:

- An **expected operational failure** is a rejected or unavailable operation represented by
  the owning feature's normal state. Its owner retains presentation and recovery. It may emit
  safe evidence only when that evidence has a named diagnostic use.
- An **invariant violation** means hvir failed to preserve an asserted product contract.
  High-confidence violations may appear in workbench health as well as the journal.
- A **diagnostic observation** is evidence whose confidence is insufficient for a product
  fault verdict. It is available only in an explicit diagnostic session or a test fixture.

The initial candidate matrix is normative:

| Candidate | Owner and mode | Contract, severity, and lifecycle | Safe evidence and bound | Confidence and test altitude |
| --- | --- | --- | --- | --- |
| React render containment | Renderer error boundary; always-on | A component render throws and the boundary presents its fallback. One degraded item per boundary and renderer generation; recurrence increments its count; a new successful renderer generation resolves the old occurrence. The boundary remains the recovery owner. | Closed classification, renderer owner/generation, opaque occurrence ID, first/last time, count; at most one 512-byte event per occurrence. | High-confidence for render containment, but does not detect event/effect errors. Direct boundary tests plus Electron evidence for post-reload visibility. |
| Main-document load failure | Window manager; always-on | A main-frame navigation emits `did-fail-load`. Critical before a usable document and degraded during recovery; deduplicated by navigation and renderer generation; a successful load or closed window resolves it. The window manager retains reload/close policy. | Allowlisted failure-code bucket, generation, occurrence ID, times, count, recovery outcome; no description or URL; at most one 512-byte event per navigation. | High-confidence for load failure, not incorrect rendered content. Electron window-lifecycle fault injection. |
| Renderer exit and recovery | Window manager; always-on | An unexpected `render-process-gone` opens one critical episode. Existing reload behavior records success, failure, or window closure; a replacement generation resolves the prior episode. | Allowlisted exit-reason bucket, old/new generations, occurrence ID, times, count, recovery outcome; no argv, stack, path, or page data; at most two 768-byte events per episode. | High-confidence for process loss, not its root cause. Electron process/lifecycle fault injection. |
| Renderer unresponsiveness | Window manager; always-on | `unresponsive` opens one degraded episode; repeated signals deduplicate until `responsive`, Wait, Reload, exit, or window close supplies a recovery outcome. Existing Wait/Reload behavior remains authoritative. | Generation, occurrence ID, times, count, and allowlisted outcome; at most four 512-byte transitions per episode. | High-confidence that Chromium declared the renderer unresponsive, but not why. Electron lifecycle coverage; no synthetic timer inference. |
| Web-pane navigation, console, or crash evidence | Web-pane feature; pane-scoped baseline and reviewed-report reference only | Existing bounded pane diagnostics and recovery remain local to the pane. A pane failure is not global health. A reviewed report may include content-free counts/classifications while the pane is still owned. Closing the pane resolves and revokes the evidence. | Pane-local opaque ID, closed category, count, first/last time, recovery state; no origin, URL, console text, body, header, form, DOM, or credential; one aggregate of at most 512 bytes per category per minute. | Navigation/crash categories are high-confidence pane events; console severity is page-authored and low-confidence. Existing web-pane tests plus Electron guest lifecycle. |
| Expected IPC or domain failure | Owning feature model; normal feature mode | A validated request returns an expected unavailable, rejected, or failed domain result. It stays in the feature's visible state and is not promoted merely to populate health. Evidence requires a separately named invariant or diagnostic question. | None centrally by default. A feature-specific closed event may include only its approved classification and opaque correlation within the common bounds. | Expected behavior, with false-positive risk if treated as app health. Pure feature policy and immediate adapter tests. |
| IPC transport or contract violation | Preload/authority router; always-on evidence, health only after a separately ratified invariant | Transport loss, unknown channel, invalid envelope, or contract validation rejects before feature work. Deduplicate by channel, outcome, and generation; recovery remains with the transport/window owner. | Allowlisted channel ID, safe outcome enum, generation, opaque correlation, and timing bucket; no request, response, send payload, error text, or stack; at most one 512-byte aggregate per channel/outcome per minute. | High-confidence contract rejection but possibly caused by stale or hostile callers. Router/manifest tests and Electron IPC-destruction coverage. |
| Responsiveness episode | Renderer diagnostics owner; explicit diagnostic mode only | A bounded episode aggregates supported timing observations after startup and while visible. Individual Long Tasks are never fault verdicts. Sleep, backgrounding, DevTools, GC, and OS contention are omitted or classified as confounders. Stop, timeout, generation rollover, or API loss resolves the episode; there is no automatic recovery. | Timing bucket, observation count, diagnostic-session and renderer generations, first/last time, and confounder enum; no input value, DOM, task attribution, stack, or content; at most one 512-byte aggregate per 30 seconds. | Low-confidence evidence with known false positives and false negatives. Deterministic fixture plus pinned Electron/Chromium and capacity coverage. |
| Layout postcondition | Owning layout/view feature; test-only unless an explicit diagnostic experiment proves value | A feature checks a semantic postcondition only after its normal resize, materialization, or transition settles. Checks are event-driven and owner-scoped; no global DOM observation or recovery policy is added. | Closed postcondition ID, tolerance bucket, generation, count, and outcome; no dimensions that reveal content, markup, selectors, or screenshot; at most one 512-byte aggregate per postcondition per minute. | Candidate-specific. Pure policy for invariant logic and focused Electron geometry for Chromium/platform behavior; macOS contracts require macOS evidence. |

Feature owners define and sanitize their closed events. Diagnostics records evidence but never
becomes the recovery or ordinary error-presentation owner. Similar-looking failures stay
separate when their authority or recovery owner differs.

### Operating modes

hvir has three diagnostic modes:

1. **Always-on packaged health** accepts only the high-confidence, content-free events named
   above. It is enabled as application behavior rather than a user recording session, has no
   screenshot or action trace, and requires no recording prompt. Its local location, current
   bound, and Delete action are discoverable from workbench health. Deletion revokes the
   current snapshot and journal generation. Health shows explicit open, acknowledged, and
   resolved states; focus never acknowledges or resolves an item.
2. **A visible diagnostic session** requires an explicit user action and shows a persistent
   recording indicator. It lasts at most 15 minutes, admits at most 512 events and 512 KiB of
   structured evidence, and offers Stop and Delete. Stopping freezes a reviewable local
   snapshot; deleting revokes it. Extending or restarting requires another explicit action.
3. **Dev/test instrumentation** requires an explicit development flag or disposable test
   fixture, never writes into ordinary packaged state, and is deleted with its fixture. Replay
   and derived-surface exploration belong to #72 or later research and may not record or replay
   a user's workspace as a consequence of this decision.

Promotion from test to diagnostic-session mode requires a fixed safe schema, deterministic
fault injection, measured cost, and a named diagnostic question. Promotion to always-on mode
requires a separately aligned issue demonstrating high confidence, low noise, useful recovery
evidence, and compliance with the always-on resource budget.

### Data, trust, and bounds

Events and reports are versioned allowlists. The common event envelope contains only a schema
version, closed event kind, process/feature owner, owner generation, occurrence time, severity,
opaque local correlation, and the event kind's closed detail fields. Strings are ASCII enums or
opaque IDs of at most 96 UTF-8 bytes. An accepted serialized event is at most 1 KiB. Unknown
versions, fields, event kinds, or enum values fail closed; consumers safely omit them rather
than preserving an arbitrary object.

Raw Error objects and stacks, IPC bodies, terminal input/output, harness prompts/transcripts,
credentials and authentication answers, environment values, filesystem write bodies, raw
paths/hostnames/URLs, web bodies/headers/forms/DOM/console streams, arbitrary feature state,
source/diff contents, and unreviewed screenshots are prohibited by construction. Correlations
are random app-local identifiers and never encode host, project, path, terminal title, provider
session, or content. Diagnostic material is untrusted data even after user review.

The renderer adapter queues at most 64 events or 64 KiB and sends batches of at most 16 events
or 16 KiB. Each source has a token bucket of four events per second with a burst of 16. The main
intake validates before admission and retains at most 256 events or 256 KiB in recent history.
Dropped counts are saturating counters by closed source and reason; they contain no rejected
payload. Overload drops diagnostics rather than delaying input, paint, PTY output, recovery,
shutdown, or feature work.

#20 owns the single app-local asynchronous writer, its startup/shutdown isolation, and durable
main lifecycle events. It rotates at 1 MiB per file, retains at most four files and seven days,
and treats unavailable or slow storage as a dropped sink. #89 may feed that writer and owns the
bounded recent-event intake; it may not create another disk writer. Journals, snapshots, and
temporary reports live under Electron's local application-data authority, never a registered
project or remote host. Local and SSH projects therefore share one local diagnostics owner.

A structured reviewed report is at most 512 KiB. An explicitly captured image is a separate
optional field of at most 8 MiB, and the complete temporary bundle is at most 10 MiB. Temporary
report material expires after 24 hours unless the user explicitly saves it elsewhere. Copy,
Save, any host crossing, and any future harness delivery show the exact selected material first.
No action writes to a project or remote host merely for convenience.

Always-on diagnostics add at most 2 MiB of application heap outside the bounded disk files and
at most 4 KiB/s of admitted serialized evidence per source. Under the representative capacity
scenario, diagnostics may add no synchronous renderer filesystem work, no task longer than 2 ms,
no more than one percentage point of process CPU, and no more than 1 ms or 5 percent (whichever
is larger) to measured input/paint latency versus the disabled baseline. Measurements are made
on Linux and macOS before an always-on detector ships. Failure to obtain evidence blocks
promotion; it does not justify a larger hidden budget.

### Lifetimes and consumers

Main assigns renderer owner/generation tokens. Every renderer event, read, and report snapshot
names the exact token. Revocation rejects queued or late events from the old generation, clears
its transport capacity, and cannot attribute work to a replacement renderer. Start, stop,
dispose, acknowledge, resolve, delete, and sink failure are idempotent; owners dispose children
in reverse order.

Workbench health consumes only ratified high-confidence events and is visually, semantically,
and programmatically separate from ADR-009 terminal/workspace/project attention, connection
state, and Git state. It never increments or clears through terminal attention and never affects
the OS badge. Pane evidence remains pane-scoped, and expected feature failures remain with their
features.

Report preparation is a named coordinator over narrow diagnostic, health, layout, and owned
surface snapshot ports. Bootstrap and renderer roots only construct, wire, start, and dispose
these owners. Direct provider delivery is not authorized here: ADR-012 and ADR-013 continue to
prohibit ambient harness inference and generic PTY writes. A later decision must choose exact
target, provider capability, host crossing, consent, and revocation semantics before delivery
can exist.

## Consequences

hvir gains one local, bounded evidence architecture without centralizing feature failure policy
or capturing ordinary user behavior. High-confidence app faults can survive renderer recovery,
while experiments remain visibly opt-in and low-confidence observations stay out of attention.
The fixed schemas and strict budgets require deliberate additions and may omit context that would
have been convenient during debugging; that omission is the privacy and responsiveness
boundary, not a deficiency to bypass with generic logging.

## Rejected alternatives

- A generic telemetry or arbitrary-object event bus; it would erase feature ownership and make
  safe bounds unenforceable.
- Global console, rejection, Error, IPC payload, DOM, input, or screenshot capture; all can
  contain excluded content and create misleading fault classifications.
- Synchronous logging, renderer filesystem access, unbounded queues, or backpressure on product
  work; diagnostics is always the work that gets dropped.
- Reusing terminal attention or its OS badge for application health; terminal focus is the wrong
  acknowledgement and resolution lifecycle.
- A periodic DOM walker, global MutationObserver, screenshot-diff loop, or universal runtime
  oracle; layout and responsiveness evidence stays owner-scoped and confidence-qualified.
- Storing diagnostics in a project or SSH host, uploading to a service, automatically filing an
  issue, or injecting a report into an ambient harness session.
