# Rich agent output experiment contract

> This is a branch-local experiment specification for epic #357, not an accepted architecture
> decision. It intentionally explores a provider/presentation boundary that ADR-003, ADR-012,
> ADR-014, and ADR-024 do not currently admit. The experiment must not merge to `main` until
> maintainers accept the behavior and a separate decision-only ADR records the resulting
> architecture.

## Question

Agent responses are now a substantial reading surface. The experiment asks whether hvir can make
live Markdown easier to scan while the native harness remains the interactive session owner.

Raw PTY output is not an assistant-output source. It mixes TUI controls, user input, commands,
tool output, approvals, prompts, and assistant text. The experiment therefore may not infer
message boundaries from PTY chunks or terminal cells.

The risky part is coexistence rather than Markdown parsing: a structured stream is useful only
if the native TUI does not also present the same assistant body. This contract tests a narrow
provider-owned routing seam so maintainers can evaluate that tradeoff with a working pilot.

## Pilot and admitted source

The pilot is **Codex CLI 0.146.x**. Other versions and providers report the capability as
unavailable.

For pilot sessions, the Codex provider starts one transient app server on the project host and
connects the unmodified native Codex TUI to it with `codex --remote`. A transient provider-owned
byte proxy sits between that TUI and app server:

- client-to-server JSON-RPC is forwarded unchanged;
- server-to-client records are framed only by the app server's newline-delimited JSON transport;
- only the typed v2 notifications `item/started`, `item/agentMessage/delta`,
  `item/completed`, and `turn/completed` participate in assistant routing;
- all requests, responses, tool records, approvals, prompts, user content, reasoning, control
  records, and unknown notifications are forwarded to the native TUI unchanged;
- invalid or unrecognized records are forwarded unchanged and revoke rich routing.

The source is the live app-server protocol connection already driving the native TUI. It is not
the persisted Codex rollout: rollout persistence deliberately omits content-delta events. It is
also not a second app-server subscriber, which could change request routing for approvals or
other single-reviewer operations.

The provider launches the app server and proxy through `ProjectHost.execStream`. A local session
and an SSH session use the same commands on their owning host. The helpers are scoped to the PTY,
use private host-local Unix sockets, install no files or service, and are disposed with the
session.

Launch-menu availability probes are advisory and may not have run before a profile starts. The
provider therefore repeats its bounded exact-version and dependency admission at session launch;
only a successfully prepared runtime advertises structured assistant output.

## Typed assistant lifecycle

The main process exposes this bounded vocabulary to the renderer:

```ts
type AssistantOutputEvent =
  | { kind: 'availability'; state: 'available' | 'unavailable'; generation: number }
  | { kind: 'start'; sessionId: string; turnId: string; messageId: string; order: number; generation: number }
  | { kind: 'delta'; sessionId: string; turnId: string; messageId: string; order: number; generation: number; text: string }
  | { kind: 'end'; sessionId: string; turnId: string; messageId: string; order: number; generation: number }
  | { kind: 'abort'; sessionId: string; turnId: string; messageId?: string; order: number; generation: number; reason: string }
```

The provider accepts only an `agentMessage` item whose `threadId` equals the exact discovered or
resumed Codex session. `turnId` and `itemId` become the turn and message identities. Source record
order becomes a strictly increasing hvir order within one observer generation.

The app-server `emittedAtMs` stamp and exact notification bytes form the bounded source identity.
A participating notification without that stamp is forwarded unchanged and revokes rich routing.
An exact repeat of the same stamped notification is idempotent; two separately emitted deltas
remain distinct even when their text matches.

`item/started` starts exactly one message. Append-only `item/agentMessage/delta` records append to
that message. `item/completed` ends it only when the completed item is the same agent message and
its final text equals the concatenated accepted deltas. A `turn/completed` notification with
`interrupted` or `failed` status aborts an open message; a `completed` status cannot substitute
for a missing item completion. Session exit, host disconnect, proxy loss, renderer revocation,
and disposal also abort any open message and reject late records.

Duplicate records with the same source identity and payload are idempotent. A repeated identity
with different content, an order gap, a revision of accepted text, a second concurrent assistant
message, mismatched completion text, or an unknown lifecycle transition revokes rich routing for
the observer generation. The provider never guesses how to repair a stream.

Subscription begins at proxy creation, before Codex starts a thread. No persisted rollout lines
are replayed. A resumed session receives only notifications emitted after its new live transport
is established. A renderer rollover creates a new presentation generation and does not replay
message bodies already accepted by the prior generation.

## Exactly-once coexistence

Rich output is a presentation-routing choice, not a second copy of the native assistant body.
The proxy assigns each agent-message item one immutable owner at `item/started`:

- **native owner:** every record for that item is forwarded to Codex and no body event is sent to
  the rich presentation;
- **rich owner:** start, delta, and completion records for that item are sent to hvir and are not
  forwarded to the Codex TUI.

Unknown and non-assistant records always retain the native owner. The decision cannot change
until the next agent-message start. Enabling rich output during a message therefore leaves that
message native; disabling it leaves the current message rich. This prevents a partial response
from appearing in both owners.

The Codex app server remains the conversation and tool-execution authority. The native TUI
remains mounted, receives input without an hvir translation layer, and continues to own its
composer, commands, tools, approvals, status, and every non-assistant record. hvir's rich lane is
read-only and receives only the assistant items the proxy withheld from that TUI.

While rich routing is healthy, each live assistant item has one visible owner. Rich items are not
inserted into terminal scrollback. Switching rich output off affects later items and does not
replay a prior rich item into the TUI.

This routing proxy is the central architectural risk under evaluation. Acceptance must explicitly
test whether withholding assistant notifications leaves the native TUI coherent across resize,
tool use, approval, resume, and subsequent turns. If not, the experiment is rejected rather than
falling back to PTY parsing.

## Ownership and dependency direction

- The **Codex provider** owns version admission, transient app-server launch, proxy framing,
  protocol parsing, thread/message identity, lifecycle validation, native-versus-rich routing,
  bounds, and cleanup.
- The **PTY supervisor** owns the provider runtime because it already owns the only PTY spawn and
  exact session lifecycle. It routes typed events to the current renderer owner and otherwise
  remains provider-agnostic.
- A renderer **rich-output session coordinator** receives the persisted Appearance preference
  and owns its per-session application, presentation generation, bounded live messages, and the
  visible lane.
- The **streaming Markdown policy** is pure. It depends only on ordered text, terminal width,
  theme capabilities, and typed link inputs. It imports no provider, IPC, PTY, or Ghostty code.
- `TerminalPane` remains provider-blind and mounted. The rich lane is a sibling presentation
  owned by the terminal runtime rather than a Ghostty extension.
- Settings and recovery do not own this state. Composition roots only wire these owners and
  dispose them.

## Control and presentation lifecycle

Appearance always exposes one **Rich output** checkbox. It is a default-off, persisted app
preference rather than capability-dependent terminal chrome. Provider eligibility remains an
implementation detail: unsupported providers and versions continue on the native PTY path
without hiding or disabling the preference.

Checking the Appearance draft reveals a deterministic visual preview built by the same bounded
Markdown policy, row renderer, typography, and rich-lane styles as live output. The preview does
not require a harness connection and explicitly does not claim provider availability; it lets
maintainers evaluate the presentation independently from the routing experiment.

The preference applies to current and later eligible sessions. A session coordinator sends its
owner-qualified desired mode only after the provider admits a healthy exact stream. The provider
acknowledges the boundary at which it takes effect. Changing the preference does not start,
restart, resume, replace, close, or focus a session. A reconnect or renderer reattachment clears
transient bodies and source generations, then reapplies the saved preference after the new exact
stream is admitted.

Hidden sessions continue receiving raw PTY data and provider notifications without a mounted
presentation. Their bounded rich state may advance only while that live session remains opted
in. Showing a hidden session renders the current bounded state; it does not request history or
replay accepted events.

The rich lane and `TerminalPane` have independent mount lifecycles. Workspace switching,
renderer rollover, and reconnect revoke old listeners before new listeners are admitted. No
provider event changes terminal attention state.

## Bounded Markdown policy

The accepted subset is headings, ordered and unordered lists, emphasis, inline code, fenced code,
blockquotes, links, and horizontal rules. Presentation uses one monospace grid and one font size.
Color, weight, backgrounds, Unicode markers, and underlining are enhancements; visible text and
structural markers remain sufficient without them.

The fixed limits are:

| Boundary | Limit |
| --- | ---: |
| source record | 64 KiB UTF-8 |
| one assistant message | 1 MiB UTF-8 |
| messages retained by one live rich lane | 32 |
| total retained message bodies | 2 MiB UTF-8 |
| session, turn, or item identifier | 160 ASCII characters |
| incomplete Markdown carry | 8 KiB UTF-8 |
| block nesting | 8 levels |
| link label | 4 KiB UTF-8 |
| link target | 8 KiB UTF-8 |
| output expansion | 4× input bytes plus 4 KiB |
| formatting work per append | linear in new input plus bounded carry |

Input is decoded as valid UTF-8 at the transport boundary. C0/C1 controls other than line feed
and tab are replaced with visible replacement characters before parsing. ESC, CSI, OSC, DCS,
APC, PM, and string terminators from source content never enter trusted output. Every styled
segment is independently closed, so source content cannot leak style state.

Stable block lines may be emitted as soon as their terminating newline arrives. Ambiguous inline
syntax and links remain in the bounded carry. If carry would overflow, the oldest ambiguous text
is emitted literally. End emits all remaining text under the best complete parse; abort emits it
literally with an explicit interrupted marker. The policy never rewrites emitted text or performs
unbounded terminal reflow.

## Links, selection, and copy

Only `https:` links and typed file links are active. Other Markdown destinations remain visible
text. Link activation is always a user gesture.

A semantic file link may use a compact filename label, but every linked cell carries the same
complete host-qualified target. Hover/focus disclosure shows the complete target. Ordinary copy
returns the visible plain text; a dedicated **Copy target** action returns the complete target.
Wrapping never creates a second relative link fragment.

File activation crosses the existing typed terminal-link boundary and retains ADR-003's active
workspace authority. The complete target must resolve within the active host-qualified workspace;
sibling worktrees and outside paths are not authorized by the label or Markdown source.

Selection and copy return Unicode text only. They never include styling controls or hidden
protocol metadata.

## Failure and privacy

A malformed, ambiguous, stale, mismatched, oversized, or out-of-order assistant stream aborts the
current rich item and disables rich ownership for later items. The proxy then forwards later
records unchanged to the native TUI. It never tries to reconstruct the suppressed portion from
PTY data.

If failure occurs before an item is assigned to rich ownership, native behavior is unchanged. If
failure occurs after assignment, the lane retains the safe accepted prefix with an interrupted
marker; the missing remainder is not duplicated from terminal output. This is deliberately
fail-closed for the affected message and fail-open for subsequent native presentation.

Message bodies exist only in the transient proxy buffers, typed IPC event, and bounded renderer
lane. The boolean Appearance preference is the only persisted rich-output state; bodies are
never written to settings, recovery, diagnostics, logs, telemetry, crash labels, or hvir-owned
files. Diagnostics may record only provider/version, availability reason, generation, lifecycle
kind, and bounded outcome buckets.

## Acceptance gate

The experiment is viable only if cumulative local and SSH acceptance demonstrates all of the
following:

- stable structure appears before an eligible assistant item completes;
- each assistant fragment is visible once and in source order;
- input, tools, approvals, prompts, commands, and arbitrary PTY output stay native;
- toggling at boundaries never restarts, replaces, closes, or loses the session;
- proxy failure has the bounded behavior above and subsequent output returns native;
- hidden output, renderer rollover, reconnect, resize, exact resume, selection, copy, and file
  links remain correct;
- formatting does not delay raw PTY delivery, input, first paint, or workspace switching; and
- the native Codex TUI remains coherent after one or more withheld assistant items.

If maintainers accept those results, a new ADR must record the app-server routing proxy and rich
lane as explicit superseding decisions before the epic branch may merge to `main`. If any
coexistence or lifecycle criterion fails, the experiment is rejected and the branch is not
merged; no PTY/screen interpretation fallback is permitted.
