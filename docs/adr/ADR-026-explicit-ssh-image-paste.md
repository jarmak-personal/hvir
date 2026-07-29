# ADR-026: Explicit SSH image paste through private remote materialization

## Context

The native image-paste chord in Codex and Claude reads the clipboard of the host on which
the harness process runs. That is the application host for a local hvir terminal, but it is
the SSH host for a remote terminal. Forwarding `Ctrl+V` therefore preserves the key while
leaving the local clipboard image on the wrong side of the host boundary.

Sending base64 text would not be an attachment: it would consume prompt context and leave
the model or harness to guess its meaning. A VS Code-style remote server could carry a
structured attachment, but ADR-010 and ADR-012 deliberately keep hvir daemon-free and retain
the provider's native terminal composer. Current Codex and Claude composers instead expose a
narrow terminal-compatible behavior: a pasted image path is recognized as an attachment and
shown in the native composer. The bytes must remain readable through submission.

The decision evidence used the current macOS application host and installed provider artifacts
available during acceptance. A graphical Linux application host and a separate Linux SSH host
were not available in that environment; those rows distinguish code-backed behavior from a
direct observation rather than claiming an unperformed platform test.

| Provider evidence | Local macOS application host | Graphical Linux application host | Harness on Linux over SSH |
| --- | --- | --- | --- |
| Codex CLI 0.145.0 | `Ctrl+V` reads the execution host through `arboard`, writes a provider temp PNG, and adds an image to the composer. | The same Rust clipboard edge is platform-native; direct hvir acceptance remains required on a graphical Linux host. | Source inspection shows the same edge would read the SSH host. The 0.145 composer recognizes a pasted image path, reads dimensions at insertion, and reads bytes again when serializing the submitted structured image. |
| Claude Code 2.1.220 | `Ctrl+V` reads the execution host with platform clipboard commands and adds an image to the composer. | The artifact contains `xclip`/`wl-paste` paths; direct hvir acceptance remains required on a graphical Linux host. | The artifact explicitly reports that no image was found when SSH has no clipboard. Its documented path workflow and inspected composer path accept image bytes from a pasted path. |

For both providers, hvir can prove only that bounded bytes were privately staged and that one
path paste was written to the exact PTY. The provider's visible native attachment is the
acknowledgement that the composer accepted it. Composer submission remains a later user action,
and only the provider/model response can demonstrate model receipt. No terminal-screen parsing
is used to turn either acknowledgement into hvir state.

## Decision

Approve a bounded terminal-compatible path contract for an explicit image-paste gesture in an
SSH terminal. This is not a general prompt or attachment delivery API.

The concrete `TerminalPane` adapter recognizes the existing `Ctrl+V`/`Ctrl+Alt+V` gesture and
emits a provider-neutral clipboard-paste event with the exact original key bytes as fallback.
Local terminals, providers without an approved contract, and clipboards without an image receive
that fallback unchanged. The pane and renderer never read image bytes or learn provider path
semantics.

A main-owned coordinator handles the approved remote case. It binds the request to the current
renderer owner and generation, immutable live PTY instance, host-qualified workspace, SSH host,
provider ID, and provider image-paste contract revision. Codex and Claude opt into revision 1;
Bare Shell, custom commands, and the other bundled providers do not. After staging, the
coordinator revalidates every binding and asks the provider for one bare bracketed-paste value.
It writes that value through `PtySupervisor` without a newline or submission. Late work fails
closed if the terminal exits, restarts, moves, changes owner generation, changes provider
capability, or disconnects.

Clipboard access occurs only inside that explicit invocation. Electron reads dimensions before
PNG encoding. One image is limited to 8,192 pixels on either axis, 32 megapixels, and 20 MiB of
encoded PNG. At most one transfer may target a terminal and at most two transfers may run across
the application. The transfer deadline is 15 seconds; individual shell control operations use
an 8-second bound. Work is asynchronous from the renderer and consumes only bounded SSH control
and SFTP capacity. Image bytes, names, and paths are not returned to the renderer or written to
logs, diagnostics, terminal recovery, or provider-profile records.

Remote material lives outside projects and repositories. The SSH host selects:

- `${XDG_RUNTIME_DIR}/hvir/image-paste/paste.<random>/image.png` when the runtime directory is
  absolute and contains only terminal-safe path characters; or
- `${TMPDIR:-/tmp}/hvir-$UID/image-paste/paste.<random>/image.png` otherwise.

An unsafe or relative `TMPDIR` falls back to `/tmp`. This constrained root plus hvir's fixed
leaf names produces a bare ASCII path that both approved composers accept without shell quoting;
the provider writes it as one bracketed paste.

The hvir root and random leaf must be real directories owned by the SSH user with mode `0700`;
the placeholder and final PNG use mode `0600`, and final type, size, and permissions are verified
through `ProjectHost`. Creation uses a collision-safe `mktemp` leaf, while transfer remains the
existing atomic SFTP write. The stable hvir root remains visible so a user can inspect, preserve,
or clear its contents deliberately.

Because neither native composer provides a trustworthy consumed-bytes callback, success means
only “path inserted” and retains the PNG. A renderer-scoped workspace lease removes it on failed
or cancelled transfer, renderer revocation, terminal exit or close, workspace revocation, or
application shutdown; a 24-hour timer bounds an otherwise-live paste. Disconnect failures are
retried after reconnect, and an idle reconnect observer is then removed. Clean shutdown makes a
bounded attempt to await staging and cleanup before host teardown. On the next image paste to a
host, reconciliation removes only stale `paste.*` image leaves older than 24 hours. A host that
never reconnects or never uses image paste
again may retain material until the user or host temp policy removes it; a remote daemon would be
required to promise stronger offline cleanup and is not authorized.

The existing persistent `ssh:<host>` project/connection presentation is the local-to-remote
disclosure for the focused terminal. The deliberate paste gesture and the provider's native
attachment display make the crossing and result visible without a recurring confirmation or a
status message. A missing native attachment remains the truthful failure signal during initial
acceptance; hvir does not claim provider acceptance from transfer completion. It does not monitor
or synchronize the clipboard in the background.

This decision extends ADR-012 with one trusted main-only native-composer capability; it adds no
renderer provider union, plugin API, or remote helper. It preserves ADR-010: every exec, SFTP,
stat, and path is host-qualified behind `ProjectHost`, and SSH remains transport rather than an
installed server. It narrowly supersedes ADR-017's rejection of remote image staging and generic
PTY injection only for a focused terminal's explicit image-paste gesture. ADR-017 continues to
govern diagnostic-report delivery, generic text or prompt injection, ambient target inference,
and automatic submission. Work from #101 contributes the exact owner/generation and revocation
concepts only; image paste does not create a shared delivery framework.

## Consequences

Remote Codex and Claude terminals can match the normal image-paste interaction without a daemon,
save dialog, `scp`, repository artifact, or replacement protocol frontend. Local and unsupported
terminal behavior stays native. Provider churn is isolated to a revisioned trusted contract, and
the native composer remains the truthful acceptance surface.

The path exists longer than the moment of insertion because current providers may reread bytes
at submission. hvir cannot truthfully announce attachment or model receipt, so it provides no
success notification. Cleanup after an offline crash is eventually reconciled rather than
instantaneous. PNG conversion and its bounded memory allocation occur in Electron main after the
explicit gesture; if future acceptance shows that bound harms main-process responsiveness, image
encoding must move to a bounded utility process without moving clipboard authority into the
renderer.

Support for another provider requires concrete path-attachment evidence and a new provider
contract revision or implementation. A provider that supplies a structured exact-composer
attachment API or a terminal protocol such as an implemented arbitrary-MIME clipboard exchange
can motivate a later decision that removes temporary files.

## Rejected alternatives

- Paste image bytes or base64 into the prompt. Text is not a structured image attachment and can
  consume context or change model instructions.
- Add a remote daemon, VS Code-style server, virtual display, X11 clipboard, or ambient upload
  service. These broaden installation and lifecycle authority beyond the explicit interaction.
- Write a path into the repository or workspace. Attachment convenience does not authorize
  project mutation or durable source artifacts.
- Delete immediately after the PTY write. Current Codex reads the path again at submission, and
  neither provider acknowledges byte consumption to hvir.
- Parse the terminal screen to find composer state or attachment acknowledgement. Display state
  is not provider authority and would make normal TUI changes unsafe.
- Generalize #101 into a prompt-delivery service. Text review and clipboard images have different
  payload, acknowledgement, retention, and host-crossing semantics.
- Show a success toast. hvir knows only that it inserted a path; the provider's native composer is
  the only truthful attachment acknowledgement.
