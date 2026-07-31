# ADR-028: Defer rich presentation inside native harness terminals

## Context

Agent responses are increasingly long-form reading surfaces, and their Markdown structure is
useful before a response completes. hvir can improve that reading experience only if it knows
which bytes are assistant text and can present them without also showing the native harness's
rendering of the same response.

Raw PTY output is not that source. It mixes native TUI control traffic, user input, tool output,
approval prompts, commands, and assistant text. Interpreting terminal cells or PTY chunks would
make harness-specific screen behavior authoritative outside the provider, conflict with the
swappable `TerminalPane` seam, and remain unsafe across local, SSH, reconnect, and renderer
lifecycles.

The bundled providers were evaluated at the currently accepted interactive boundary:

| Provider | Structured source | Native interactive coexistence |
| --- | --- | --- |
| Claude Code 2.1.220 | The [supported partial-message stream](https://code.claude.com/docs/en/cli-reference) requires print mode with `stream-json`. [Interactive hooks](https://code.claude.com/docs/en/hooks) expose turn completion and transcript location, while hvir's existing transcript observer intentionally accepts only bounded usage records. | Print mode would replace the native interactive harness. The interactive TUI has no supported mode that omits exactly its assistant response while retaining its composer, tools, approvals, and other output. |
| Codex CLI 0.146.0 | [`codex exec --json`](https://developers.openai.com/codex/cli/reference) is non-interactive. The app server exposes structured events but is experimental, and the persisted rollout used by hvir's bounded context observer is not a supported presentation API. | A TUI connected to an app server still renders the response. The [configuration surface](https://developers.openai.com/codex/config-reference) has no supported setting that suppresses only the native assistant rendering. |
| Cursor CLI, Gemini CLI, GitHub Copilot CLI, and Pi | Their bundled hvir providers are launch-only and expose neither exact live-session identity nor a trusted structured observer. | No bundled coexistence contract is available. |

A trustworthy assistant stream alone therefore does not satisfy the product contract. Writing
that stream to the terminal would duplicate the native response. Filtering, erasing, restyling,
or covering the native response would require terminal-screen interpretation or provider-specific
renderer behavior. Driving a print, SDK, RPC, or app-server session from hvir would replace the
native harness with a transcript frontend.

## Decision

Do not select a Phase 1 pilot provider. No Claude Code, Codex, Cursor CLI, Gemini CLI, GitHub
Copilot CLI, or Pi version is admitted for rich presentation, and the rich-output experiment
stops before adding a formatter, assistant-output capability, setting, or terminal integration.
Native PTY presentation remains unchanged.

A future proposal may supersede this decision only when one bundled provider offers a supported,
versioned native-interactive coexistence contract with all of these properties:

- A provider-owned source distinguishes assistant text from user input, tool output, approvals,
  prompts, commands, and arbitrary PTY data. Events carry exact host, provider, session, message,
  lifecycle generation, source revision, and monotonic order.
- The source is live early enough to emit stable content before response completion. It defines
  start, append-only delta, end, and abort behavior; duplicates are idempotent, while gaps,
  revisions, ambiguity, malformed records, overflow, and late completion fail closed.
- Subscription starts from an explicit live baseline and never presents historical replay as new
  output. Reconnect and reattachment preserve message identity without replaying accepted
  content. Revocation and disposal are idempotent and reject later events.
- The same supported provider mode prevents the native TUI from drawing exactly the assistant
  body that hvir presents, while preserving the native composer, input, tools, approvals,
  commands, session identity, exact resume, and other PTY output. Source failure has a defined
  non-duplicating recovery path. hvir does not infer, filter, erase, repaint, or cover terminal
  cells to create this behavior.
- Main-owned provider observation flows through a named rich-presentation coordinator to a
  provider-blind terminal-presentation port. Pure Markdown policy depends only on bounded text,
  width, theme, and typed-link inputs. Composition roots only wire and dispose these owners.
- Observation uses `ProjectHost` for equivalent local and SSH behavior, installs no remote
  service, stays off the render thread, and does not delay PTY delivery, input, first paint,
  workspace switching, or hidden-session output.
- Content, identifiers, nesting, carry, processing time, and concurrent messages have explicit
  bounds. Source terminal controls are removed before trusted controls are added. Message bodies
  remain bounded in memory and never enter recovery records, settings, diagnostics, logs, or
  retained telemetry.
- Rich presentation is off by default and enabled only by a visible per-live-session control.
  The choice is memory-only, is not a global default, and is not restored as recovery state.
  Changes made during a response take effect at the next message boundary so one message cannot
  switch presentation owners midway.
- Selection and ordinary copy return the visible assistant text with no terminal controls.
  Semantic file links may shorten only their visible label: every linked cell retains the same
  complete typed target, target disclosure shows that complete target, copying returns the
  complete target, wrapping does not create a separately resolved fragment, and activation
  remains confined to ADR-003's active host-qualified workspace.

Provider observation remains optional and cannot affect generic attention. Hidden sessions may
be observed only while their independently owned live session and explicit rich-presentation
choice require it; mounting a `TerminalPane` is not a prerequisite for session correctness.

## Consequences

hvir does not ship a control that cannot produce a truthful single rendering. Plain shells,
custom commands, bundled harnesses, local sessions, and SSH sessions retain their existing PTY,
selection, copy, link, attention, recovery, and presentation behavior. No transcript body gains a
new persistence or telemetry path.

The deferred experience may become viable if a provider adds selective native-render ownership
or another stable terminal-compatible semantic presentation protocol. That change requires
concrete local and SSH evidence, an admitted provider version range, a superseding ADR, and fresh
implementation issues. A structured stream that still duplicates the native TUI is insufficient.

## Rejected alternatives

- Follow Claude Code transcripts or Codex rollouts and write assistant text beside the native
  response. The artifacts are useful for bounded provider telemetry, but a second rendering
  violates the once-only outcome.
- Correlate semantic deltas with PTY chunks or terminal cells and suppress, restyle, erase, or
  overwrite matches. This makes unstable TUI layout and terminal-engine internals part of the
  provider contract and can corrupt unrelated output.
- Hide or cover the native terminal with a rich transcript surface. This creates a second
  transcript model, obscures native tools and approvals, changes selection and copy ownership,
  and still leaves duplicated scrollback.
- Launch Claude Code print mode, `codex exec --json`, an SDK, or an app-server client as hvir's
  conversation frontend. This replaces the user's native terminal harness and crosses ADR-012's
  explicit extension boundary.
- Format every PTY stream heuristically. Shells, custom commands, prompts, tools, and control
  traffic are not assistant Markdown.
