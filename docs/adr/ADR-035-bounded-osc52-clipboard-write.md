# ADR-035: Bounded OSC 52 clipboard write

> Lifecycle: Active
> Supersedes: [ADR-014](ADR-014-modular-monolith-ownership.md) | partial | Expiry and removal metadata requirement for the named terminal-runtime.ts 600-line non-growth cap.

## Context

OSC 52 lets a program attached to a terminal request access to the application-host clipboard.
Remote tmux uses its write direction to make a copy on an SSH host available to the local user.
Without application support, tmux reports the copy but hvir drops the structured clipboard event.

`ghostty-web` owns escape-sequence parsing, chunk reassembly, and parser bounds behind
`TerminalPane`. It emits the selection and base64 payload as an engine-neutral terminal event. It
does not decode the payload. The system clipboard is an Electron main-process resource and must
not become renderer authority.

The write direction has a deliberate security cost. Any program in an attached terminal can
replace the application-host clipboard without a separate local confirmation. The read direction
has a different and greater authority: a reply would disclose local clipboard contents to the
program that requested them.

## Decision

hvir honors bounded OSC 52 writes to the system clipboard. It never answers OSC 52 read queries.

The renderer accepts the default selection or a selection that includes the clipboard target. It
refuses other selection targets. It bounds the encoded payload before decoding. It requires strict
base64, valid UTF-8, and non-empty decoded text. A refusal writes nothing. A successful decode
preserves the complete decoded text. It does not remove, replace, normalize, or truncate valid
text.

`TerminalRuntime` forwards an accepted write only while its pane has a live started PTY. A pane
with unavailable recovery, a failed launch, an exited PTY, or released runtime authority cannot
write the clipboard from a replayed or trailing event.

The renderer sends only decoded text through the typed `terminal:clipboard-write` channel. The
main IPC authority router qualifies the current renderer owner and generation. The clipboard IPC
adapter independently requires a non-empty string and applies a fixed UTF-8 byte bound before it
calls Electron's text clipboard API. Renderer validation is not evidence at the IPC boundary.

The policy is provider-neutral and host-neutral. Local and SSH terminals use the same event path.
No project path, `ProjectHost` operation, harness-provider behavior, PTY write, remote helper, or
persistent resource is involved.

This direction is separate from ADR-026. ADR-026 governs one explicit local-to-remote image-paste
gesture, private remote material, provider composer contracts, and cleanup. This record governs a
terminal program's remote-to-local or local-to-local text clipboard write. It does not change
ADR-026 or authorize another clipboard crossing.

`terminal-runtime.ts` permanently receives a named 600-line architecture cap. The runtime is the
existing owner of pane listener wiring and live PTY lifecycle authority, including this liveness
check, and future terminal events are expected to use the same owner. This path-specific cap
narrowly supersedes ADR-014's expiry and removal requirement for architecture exceptions. The cap
remains a blocking non-growth ratchet. It does not authorize unrelated product workflows or a
composition-root role in the runtime.

## Consequences

A copy inside tmux with OSC 52 clipboard writes enabled reaches the application-host clipboard as
the decoded text. The same behavior is available to local terminal programs that emit OSC 52.
Malformed, empty, oversized, non-UTF-8, unsupported-selection, read, stale, and non-live requests
leave the clipboard unchanged.

A hostile or compromised program in a live terminal can overwrite clipboard text. Size and
liveness bounds contain allocation and stale-lifecycle risk, but they do not make the text
trustworthy. hvir matches the terminal protocol without claiming that later paste use is safe.
Because no read response exists, OSC 52 cannot use this capability to retrieve the local
clipboard.

The renderer performs one bounded decode for each accepted parser event. Main performs one
bounded synchronous UTF-8 size check and clipboard write. The feature creates no background work,
cleanup obligation, local/SSH branch, or new terminal-engine dependency.

## Rejected alternatives

- Answer OSC 52 reads. The desired remote-to-local copy flow does not require local clipboard
  disclosure.
- Require confirmation for every write. This would not behave like the copy operation the
  terminal protocol represents.
- Add a second local setting for each session. The initial contract uses terminal liveness and
  the remote program's OSC 52 configuration as the visible operating context.
- Forward the encoded payload. Electron would receive base64 instead of the copied text.
- Silently remove terminal control characters. That would partially apply accepted input and
  change copied text. A future content restriction must refuse the complete payload and update
  this decision.
- Move clipboard authority into `TerminalPane` or the renderer. That would couple the engine seam
  to Electron resources and bypass main-process authority.
