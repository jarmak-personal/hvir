# ADR-031: Explicit document review anchors and provider-safe handoff

## Context

hvir users review agent-authored Markdown in the viewer and respond through native harness
terminals. Reconstructing every document location in a terminal is cumbersome, but treating an
editor selection, clipboard, focused terminal, or other ambient state as agent context would make
the payload and destination unpredictable. Review notes must remain lightweight metadata rather
than document edits or a general annotation platform.

The workflow crosses renderer interaction, durable user-authored state, project watching,
host-qualified reads, harness-provider semantics, and live PTY authority. Those concerns have
different owners. Collapsing them into viewer components, renderer storage, IPC registration, or
the PTY supervisor would duplicate policy and weaken the lifecycle boundaries established by
ADR-003, ADR-004, ADR-007, ADR-008, ADR-009, ADR-010, ADR-012, and ADR-014.

Terminal text delivery is also not generically safe. A PTY can be live while its foreground TUI
is not accepting composer input; multiline text can become several submissions; submit bindings
vary by provider and configured composer mode. Document review therefore needs a narrow contract
in which the user sees the exact message and destination and a trusted provider proves the
permitted composer operation.

## Decision

### Scope and ownership

The initial review capability applies only to Markdown documents. It adds review metadata and
viewer interaction; it does not expand minor edit-and-save, introduce general code or diff
annotations, or create threaded or agent-authored review state.

Review state is qualified by one host-qualified workspace root and one host-qualified document
path contained by that workspace. A workspace is an exact registered project/worktree identity,
not merely an equal-looking path. Local and SSH workspaces use the same model, and no review
action may move or combine state across host or workspace identity.

Ownership is divided as follows:

- A dependency-free document-review model owns anchors, exact revalidation, batches, lifecycle,
  delivery eligibility, and review-record size and count policy. A separate dependency-free
  delivery policy owns deterministic grouping, exact body formatting, and payload bounds. Neither
  imports React, preload, main-process, provider, PTY, or terminal implementation.
- The renderer owns the active review model and Markdown interaction. Rendered and source views
  consume the same review records; the renderer shell only composes the feature owner.
- A specialized main-owned document-review store under Electron user data owns durable
  user-authored review records. It is not a generic persistence service.
- A named main-owned review-delivery coordinator owns the viewer-to-terminal workflow through
  narrow review-store, provider, live-terminal, renderer-resource, and PTY-supervisor ports. IPC
  validates and translates messages but owns no review or delivery policy.
- Trusted bundled harness providers own composer insertion and optional submission semantics.
  The PTY supervisor remains the sole authority for the resulting write, and `TerminalPane`
  remains provider- and review-blind.

### On-disk anchors and revalidation

A review anchor records the identity of the exact on-disk UTF-8 Markdown snapshot, its inclusive
one-based source line range, the exact source excerpt for that range, and bounded exact context
immediately before and after the excerpt. Snapshot identity includes a cryptographic digest and
byte length of the bytes read through `ProjectHost`; renderer buffer identity, modification time,
or a Git revision alone is not sufficient.

Rendered capture is block-level and uses the Markdown renderer's deterministic source-line map.
Source capture uses an explicit line or line range. Both reduce to the same source anchor, so
switching representation neither duplicates nor relocates a comment. Arbitrary rendered DOM
selection is not an initial capture authority.

Only an explicit add-comment action may capture an anchor. Selection, clipboard contents, tab
state, terminal focus, and other ambient state are inert. Capture is unavailable while that
document has unsaved viewer edits because the harness can read only the on-disk document.
Existing anchors remain tied to their last disk snapshot while dirty, and revalidation resumes
only against a later bounded disk read. Moving a comment is deliberately a delete-and-recreate
interaction rather than a separate re-anchor workflow.

The existing project-watch pipeline contributes one bounded interest for a reviewed document,
independent of its comment count. A relevant change schedules an off-paint, bounded
`ProjectHost` read. There is no watcher per comment, recursive review scan, new SSH polling loop,
or remote helper.

When the snapshot changes, revalidation searches the new on-disk document for the anchor's exact
excerpt together with its exact bounded surrounding context. Exactly one match moves the current
line range while retaining the previous range and snapshot for visible moved-state presentation.
Zero matches, multiple matches, deletion, an incomplete bounded read, invalid text, or an
unavailable host makes the anchor stale with a visible reason; none may silently select a
location. Stale state is independent of comment lifecycle. A stale comment is excluded from
delivery until the user makes an explicit stale-review decision or establishes a current anchor.

### Persistence, lifecycle, and bounds

The main-owned store uses a versioned envelope, one serialized writer, and crash-safe atomic
replacement. A failed write leaves the last valid durable envelope intact. Corrupt or
future-versioned user-authored data is preserved aside and reported as recoverable; hvir does not
silently replace it with an empty store. Review data is never written to a project, Git index,
SSH host, provider record, or terminal recovery record.

Application composition explicitly loads, flushes, and disposes the store. Shutdown makes one
bounded flush attempt without delaying paint, terminal input, or host teardown indefinitely.

Draft review state survives tab close, workspace navigation, renderer reload, and ordinary
application restart. Runtime workspace revocation cancels reads, writes, watch interests, and
delivery attempts, but it does not silently clear already durable review history. Store and
renderer revisions reject late completion from a replaced renderer or workspace generation.

The current comment lifecycle is `draft` to `sent`. Anchor state, including current, moved, or
stale, is orthogonal. Copying a payload or inserting it into a composer does not advance the
lifecycle. Only a successful provider-owned send-now write may advance the exact included drafts
to sent. Sent means accepted by the owned PTY boundary, not read, accepted, or acted on by the
agent. Clearing sent history is explicit; no age, agent output, attention signal, or file edit
clears it automatically. Existing `resolved` records from earlier versions remain readable and
explicitly clearable, but the streamlined inline workflow creates no new resolved state.

The pure review policies define fixed limits for comments per workspace and document, comment and
anchor text, excerpt and context, source range, batch membership, stored bytes, revalidation read
bytes, and outbound payload bytes. Limits apply before persistence and again at trust boundaries.
Identity-bearing anchor text and user comment text are rejected when they cannot fit; they are
never silently truncated into different review meaning. A short payload quote may be visibly
truncated under its own declared bound. Count, storage, read, and payload exhaustion produces an
explicit refusal or truncation notice and never silently drops comments or documents.

### Exact batches and payload bytes

A batch contains one or more eligible draft comments from exactly one host-qualified workspace
and may span several Markdown documents in that workspace. It is grouped deterministically by
workspace-relative document path and source position. A one-comment handoff is the same contract
as a batch of one.

The human-readable body identifies each document as user feedback/review, then contains only, for
every included comment, the workspace-relative `path:line-range`, a bounded source quote, and the
user's comment. It contains no active or historical selection, clipboard data, full document,
extra neighboring source, other tab, terminal output or transcript, Git state, provider metadata,
or hidden instructions. Resolved, stale, over-limit, cross-workspace, and otherwise ineligible
records cannot enter a prepared body.

Payload construction normalizes line endings to line feed and refuses NUL, escape, and other
terminal control characters except horizontal tab and line feed. Unsafe path text is refused
rather than emitted as terminal control. These rules apply equally to source quotes and comments.
They preserve multiline human-readable text while preventing user-authored bytes from breaking
terminal framing.

Preparation produces one immutable UTF-8 body. Preview decodes those bytes, Copy copies those
bytes, insert frames those bytes, and send-now frames and submits those same bytes. Transport
framing is not part of the message body and may not add, remove, rewrite, or hide body content.
Any edit, batch change, revalidation result, or destination change invalidates the prepared
delivery and requires a new preview.

### Explicit destination and provider-safe delivery

The full Review-and-send surface lets the user explicitly select one live terminal in the same
host-qualified workspace. A one-step handoff may instead choose the first live terminal in the
workspace's visible persisted terminal order. This is a fixed, exposed ordering rule rather than
focus inference; the resulting action reports the chosen title and capability outcome. The full
choice shows the terminal title, provider, liveness, host connection, and available
review-delivery capabilities. A prepared destination snapshots the immutable PTY instance,
terminal identity, renderer owner and generation, workspace root, host, provider, effective
capability revision, and configured composer-submit mode. Later focus, pane, tab, workspace,
title, or attention changes never retarget it.

Immediately before a write, the delivery coordinator revalidates the renderer generation,
workspace, live PTY instance, ownership, host connection, provider, effective capabilities,
payload bounds, and contract revision. Failure or drift preserves the comments and prepared batch
for an explicit retry, new preview, or Copy.

Attention and provider telemetry may warn that harness foreground state is uncertain, but Ready,
Working, focus, output quiet, titles, and telemetry are not reliable busy or composer detectors.
The coordinator never scrapes terminal contents, waits for a prompt, or silently chooses a
different destination.

Copy is the universal fallback and grants no terminal authority. A one-step handoff sends through
a proven send-now contract, inserts through a proven insert-only contract, or copies when its
deterministic first destination is Copy-only. Insert into composer is available only when a
trusted bundled provider's effective
capabilities declare a revisioned atomic bracketed-paste contract for the exact launch. A bundled
provider may treat its live provider-default executable as a best-effort composer target despite
data-only profile argument, environment, path-binding, or risk customization; hvir warns that it
cannot prove the foreground composer, makes only the explicitly requested provider-owned write,
and preserves the prepared review on a reported write failure. A custom executable never gains
that trust from its provider label. The provider returns one complete framing sequence for one
PTY-supervisor write, with no submission sequence. Literal newlines remain inside that one paste
and cannot become partial submissions. A successful insert leaves comments draft because the user
still controls native composer submission.

Send-now is a separate, optional, explicitly selected action. A trusted provider may expose it
only when its effective capabilities, active launch/profile contract, configured
`ComposerSubmitMode`, and atomic-paste contract together prove the exact submission sequence. The
provider returns one complete transport sequence containing the same bracketed payload body
followed by its provider-owned submit binding; the coordinator never appends a generic newline,
carriage return, Enter, or control-key guess. A complete accepted supervisor write advances only
the included drafts to sent. Any validation or write failure leaves them draft.

Plain shells, custom commands, unsupported provider versions, and providers without a proven
contract remain Copy-only. The contract is identical for local and SSH terminals: the document
and destination must share the same host-qualified workspace, all reads and PTY operations remain
behind `ProjectHost`, and SSH receives no review store, sidecar, daemon, or helper.

### Relationship to existing terminal delivery decisions

ADR-013 reserves future direct harness delivery for an explicit provider capability routed
through exact PTY ownership rather than a generic PTY write. Document review exercises that
reserved boundary with a narrower terminal-byte contract: one immutable body and destination are
visible before authorization; the effective provider capability and revision are bound to the
live PTY instance; every owner, generation, workspace, host, and provider binding is revalidated;
and the provider frames the complete multiline body as one atomic bracketed paste for one
supervisor write. Bracketed paste keeps body newlines literal, the provider-owned revision keeps
terminal and composer semantics out of the coordinator, and the exact prepared bytes prevent the
transport from adding hidden context. Those properties, plus Copy-only failure for every
unproven target, are why terminal bytes are accepted for this one workflow. They do not authorize
a generic write API or claim that terminal liveness proves foreground composer state.

This record therefore narrowly supersedes ADR-017's rejection of PTY text delivery only for an
explicit, visibly prepared document-review payload under that revisioned atomic-paste contract.
Diagnostic reports retain Preview, Copy, and Save; arbitrary text, ambient target inference,
generic prompt injection, attachments, and new-conversation orchestration remain deferred.

Document-review delivery and ADR-026 remote image paste remain separate coordinators. Review
delivery handles visible UTF-8 feedback bodies, insertion-versus-send acknowledgement, current
`draft`/`sent` state, and readable legacy `resolved` records without remote material. Image paste
handles clipboard PNG
authority, private SSH staging, native attachment acknowledgement, retained bytes, expiry, and
cleanup. They reuse the stable renderer-resource and PTY ownership primitives and the same exact
renderer owner/generation, live PTY instance, workspace, host, provider, and capability-revision
binding concepts. They do not duplicate that generic authority policy inside feature views or
providers, but their different payload, acknowledgement, retention, and lifecycle semantics do
not justify a shared prompt-delivery service or shared coordinator state machine.

## Consequences

Review becomes a durable, view-first workflow with explicit capture, exact payload disclosure,
stable destination authority, and conservative anchor movement. Rendered and source Markdown
share one model, while local and SSH projects share one host-qualified policy without remote
state.

Exact matching intentionally produces stale comments when context is missing or ambiguous; the
user must resolve uncertainty rather than hvir guessing. Durable local storage contains bounded
user comments and source excerpts, so corruption handling, explicit clearing, and user-data
privacy remain part of the review feature's responsibility.

Insert-first delivery preserves the native composer as the normal confirmation surface.
Send-now can be convenient but remains visibly less certain about foreground TUI state; support
for each provider and submit mode requires concrete, versioned evidence. hvir can truthfully
claim only PTY-boundary acceptance, never agent receipt or agreement.

The workflow adds a specialized store, pure model, renderer feature owner, and delivery
coordinator, but no generic annotation service, prompt-delivery API, provider UI extension,
terminal macro system, remote process, or new application process boundary.

## Rejected alternatives

- Treat selection, clipboard, focused terminal, active tab, Git state, or terminal output as
  ambient agent context. The user could not know what or where hvir would send.
- Store review state only in React, renderer storage, repository sidecars, document comments, or
  an SSH service. Those choices lose durable authority, modify user content, or break local/remote
  parity.
- Anchor rendered DOM ranges, modification times, or line numbers without snapshot content.
  Representation and ordinary edits would silently detach comments from source meaning.
- Use fuzzy, semantic, or first-match re-anchoring. A plausible match is not authority to move
  user-authored review state.
- Watch every comment or add a review-specific remote poller. Document interests already belong
  to the bounded project-watch pipeline.
- Format preview, clipboard, insertion, and submission independently. Equivalent-looking text is
  insufficient when the user is authorizing exact bytes.
- Infer a destination from focus, title, cwd, provider session, or apparent authorship. Ambient
  presentation is not conversation authority; only explicit selection or the visible persisted
  terminal ordering may choose a destination.
- Write generic text or append Enter through the PTY supervisor. PTY ownership alone does not
  prove atomic composer or submission semantics.
- Parse the terminal screen or treat attention as a composer-state oracle. Both are incomplete,
  provider-fragile heuristics.
- Mark copied or inserted comments sent, or infer resolution from agent output. Neither operation
  proves submission, receipt, or agreement.
- Generalize the first release into code annotations, threads, an agent protocol frontend, a
  provider plugin API, or conversation orchestration. Those are outside hvir's review contract.
