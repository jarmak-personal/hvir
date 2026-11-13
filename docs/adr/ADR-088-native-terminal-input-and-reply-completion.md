# ADR-088: Native terminal input and reply completion

> Lifecycle: Active

## Context

[ADR-086](ADR-086-native-terminal-state-and-presentation.md) separates native terminal
state from its presentation. Browser gestures, parser replies, asynchronous native IO,
and the existing PTY transport consequently have different owners and completion points.
A parser accepting a mode change does not prove its generated reply has reached the
response callback. A key encoder returning does not prove that reply was appended first.
A frame carrying a mutation does not prove it was physically presented.

Input must preserve hvir's provider behavior, exact PTY authority, composition and focus
lifetimes, and responsiveness while using the same native state that renders the pane.
This decision refines that input boundary. It leaves presentation transfer, device selection,
and [ADR-087 quarantine](ADR-087-indeterminate-native-presentation-quarantine.md) unchanged.
Terminal-related decisions remain reviewable when the environment changes.

## Decision

Keep one authoritative Ghostty Surface/parser for encoding, input state and rendering.
Reuse its mature key, paste, focus, mouse, wheel and linefeed mechanisms. Terminal-only
input bypasses ambient OS key translation and Ghostty application bindings. Genuine pinned
upstream hooks expose a fixed input emission path at proven input callsites, separate from
the parser/control reply callback. Neither temporary callback swapping nor treating every
Surface write as user input establishes provenance. Callbacks copy borrowed data and do
not reenter the parser or invoke product policy.

Main owns a focused input coordinator behind the existing application/view boundary.
It qualifies the immutable PTY instance, native generation, renderer owner, attachment,
acknowledged geometry and visibility before native work and again before transport effects.
The existing PTY supervisor and ProjectHost remain the transport authorities. Renderer
payloads supply gestures, not provider policy, input provenance or private native options.
Keyboard, composition and ordinary paste require the current keyboard focus lease. A valid
visible pane may emit application mouse/wheel reports to its own PTY without acquiring
another pane's keyboard focus.

Provider composer, submit and Meta policy comes from the main-owned provider contract.
Where a provider needs a compatibility encoding, main supplies a private native fallback;
parser-negotiated Kitty or modifyOtherKeys behavior takes precedence. This does not create
a renderer mode mirror or replace native encoders with hvir sequence tables.
Provider-prepared document/image delivery remains its approved complete transport payload
and bypasses ordinary native paste encoding. Explicit clipboard gestures and their exact
fallback retain their existing clipboard/provider owners.

A pane-owned DOM input subordinate owns the real text host and browser transactions:
key press/repeat/release, beforeinput/composition duplicate suppression, preedit commit or
cancel, pointer capture, wheel units and caret placement. It keeps active browser preedit
intact and applies caret geometry only to its current acknowledged attachment. Physical key
codes are distinct from layout characters; missing layout evidence stays unknown rather
than assuming US text. Native mouse state and terminal modes remain authoritative.
Existing workbench capture routing retains reserved shortcuts. Revocation stops new gestures
and invalidates late caret/capture/notification results before reparenting or replacement.

The existing authoritative output ingress captures a finite source-admitted UTF8 prefix.
Input reserves existing command credit before waiting for that prefix; later continuing
output does not extend it. Two gates describe the captured prefix:

- **Parsed:** each corresponding native feed has been parsed, so encoding can use its modes.
- **Replies dispatched:** replies through that prefix have been appended through the captured
  response writer, or the empty/known-input-closed case has settled explicitly.

Parsed progress is reported before response/effect housekeeping. A separate native feed IO
sequence is acknowledged by the existing IO mailbox after that feed's reply-producing
messages. The sole reply consumer waits for this sequence through short producer-qualified
inspect jobs before draining the callback FIFO. It invokes the captured transport response
writer before publishing replies-dispatched progress. User input may encode after parsed
progress but waits for replies-dispatched before invoking its own transport write.
Dispatched means the ordered transport call was invoked, not confirmed delivery or paint.
The existing transport owns byte ordering; this adds no byte queue or parallel reply consumer.

Eligibility waits consume no blocked physical native caller job. Existing bounded admission
preserves producer feed, progress inspection, reply/effect housekeeping and cleanup capacity
without bypassing absolute limits. There is one producer native job per state at a time.
Neither gate waits for EOF, a global stream drain, future output or a GPU lease. Cancellation,
close and loss settle both prefix phases and revoke authority; they do not erase physically
outstanding work or manufacture completion.

Native input returns one owned raw byte body, explicit user/control provenance, admitted
result capacity and a requested mutation serial. User bytes take the generation-qualified
supervisor writer and user observation path. Parser replies, synthetic focus cleanup and
related control bytes use the captured instance writer without user-typing/composer
observation. Native IO-applied mutation is acknowledged after preceding IO effects,
independently of hidden or stalled rendering.

The renderer samples mutation serial with content/preedit, parsed stream sequence and
geometry under the same native state/snapshot lock. Cached redraws retain their cached
serial. Requested mutation, native IO application, transport append/confirmation, an observed
native snapshot, and physical presentation remain distinct. A serial alone does not establish pixel content
or successful presentation.

Hide, blur and replacement capture cleanup against the old instance and attachment.
Replacement input on the same immutable PTY waits for its native preedit/key/button cleanup
and confirmed control write, or known physical input closure. The existing native-session
record retains the physically unsettled input and cleanup barrier across detached views
and renderer ownership changes. Input captures the prior barrier before registering its
own operation, then revalidates current authority and the sticky unavailable outcome after
waiting. Captured cleanup does not wait on that barrier or introduce a cycle against its
active operation; the record joins their physical settlements for subsequent input.
This is instance lifetime bookkeeping, not a command queue or another registry.
An independent terminal does
not wait for another PTY's backpressured acknowledgement. Captured cleanup can proceed once
the old operation can append no more user bytes; its transport/result credits stay owned
until physical completion. Late cleanup cannot change a newer focus owner. No focus transition
waits for an occluded frame. A finished terminal
retains native history and viewport navigation. Main derives a private readonly capability:
wheel/position navigation can move that same Surface's viewport while application reports,
alternate-screen input fallbacks and PTY writes are suppressed. Readonly navigation does
not grant a new input owner or a replacement PTY.

Preflight and bound native result capacity using authoritative native state, including
pending wheel accumulation, cell metrics, scale and encoder modes. Retain admitted capacity
through native physical completion and confirmed transport writing; unknown physical write
completion does not release it. Proven-unsent capacity refusal is visible and recoverable.
It produces no accepted-input notification or automatic replay. Partial native mutation
cannot be blindly retried. Refused release/cleanup must settle native control state or
expose an unavailable input outcome.

Ordinary paste uses input-relative dynamic allocation with checked capacity for native
normalization, linefeed expansion and framing. A nonempty result is appended in one complete
confirmed PTY write, with operation-specific resource admission rather than key/reply/feed
buffer limits. This decision selects no ordinary-paste source ceiling. It authorizes neither
truncation nor splitting one paste into multiple transport writes.
The ordinary result-capacity budget limits concurrent ownership, not the size of a paste.
An individually oversized paste can own one dynamically sized reservation when no other
paste is physically owned. It excludes other pastes until settlement while ordinary input
and cleanup retain their independent admission budget. Shared input-result accounting owns
only scalar credits and release tokens, with no command queue or additional registry.
Trusted Node owners measure UTF8 length without a full encoded preflight copy. Checked
capacity and proven pre-mutation allocation failure produce a recoverable refusal without
automatic allocator retry; unknown post-mutation completion remains indeterminate.

## Consequences

An indeterminate live transport write makes input unavailable on the retained terminal
instance. Replacing a view does not clear that outcome or authorize replay. Parsing,
display and read-only navigation remain available. A transport-confirmed write whose
delivery authority expired afterward is a distinct rejected completion: reject it
without replay, but do not turn known physical completion into instance failure.

Input shares actual parser modes and native state while retaining hvir's provider and trust
boundaries. Output can continue and hidden state can progress without tying input completion
to paint. Explicit parse, feed IO and reply-dispatch fences prevent a late parser reply from
being stranded or appended behind a dependent user write.

This requires maintained upstream hooks, versioned C/private ABI contracts and explicit
lifetime handling at browser, main, utility and transport boundaries. Admission accounting
for result capacity is not a bound on physical working set: native allocations, text,
N-API, process-port and transport copies may coexist. Allocation/copy and responsiveness
claims need separate evidence. Programmatic DOM composition is not OS input-method
acceptance; snapshot metadata is not a physical presentation guarantee.

The decision changes no unrelated ADR rule, native resource quarantine, provider-prepared
delivery contract, or selection/search/terminal-effect authority. Those capabilities retain
their own owners and decisions.

## Rejected alternatives

- A new fixed paste-source ceiling, or treating the ordinary concurrency budget as an
  equivalent size ceiling: changes an existing paste contract during an engine migration.
- A second parser or renderer-side mode mirror: it can encode against different state.
- Main or browser sequence tables replacing native negotiation: duplicates mature encoders
  and can override application-selected protocols incorrectly.
- Treating parse/feed return as reply completion, or draining once immediately afterward:
  asynchronous IO replies may not have reached the callback FIFO yet.
- Waiting for complete output quiescence or a GPU frame before input: continuing output,
  hidden views and held consumers could block healthy interaction indefinitely.
- Holding a physical native job while waiting for its prerequisite feed: it can wait behind
  itself; consuming producer/cleanup credit with ordinary waits has the same failure mode.
- Multiple reply consumers or another byte router: they duplicate ordering and authority
  already owned by the existing ingress and transport.
- Freeing result credit on logical abort, or retrying possibly mutated input: neither proves
  physical completion or prevents duplicated bytes.
- Replacing the uncapped paste contract with a key buffer limit: those limits describe
  different operations and do not authorize a new product ceiling.
