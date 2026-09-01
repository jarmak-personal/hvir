# ADR-039: Let one native fork authorize one exact preserved-conversation resume

## Context

A native harness fork leaves two conversations that can both remain meaningful: the fork that the
current terminal enters and the original that the gesture preserves. Keeping both available in
hvir can remove a repetitive recovery step, but automatically starting another harness normally
requires a separate explicit user gesture. Treating any apparent conversation change as authority
would instead make hvir an ambient session orchestrator and would weaken exact recovery.

The native provider is the only valid owner of fork semantics. Terminal input and output, artifact
recency, cwd and timestamp proximity, and an identity change without an exact fork relationship do
not establish either what the user requested or which conversation was preserved. Some providers
may also prevent the preserved conversation from being resumed while the fork remains live.

## Decision

One explicit native conversation-fork gesture in a current hvir-owned live terminal may authorize
exactly one automatic exact resume of the conversation preserved by that gesture. This authority
exists only when a trusted bundled provider supplies one content-free, provider-owned, committed
original-to-fork transition and qualifies the preserved original for concurrent exact resume.
The two live conversations must retain independent provider artifacts and cannot interleave
messages.

The transition must belong to the terminal's current PTY lifetime and exact host-qualified
workspace, cwd, provider, launch profile, and launch revision. The existing terminal remains with
the fork. The one automatic action targets only the transition's preserved original, through the
provider's exact native recovery mechanism. Failure is visible and closed: hvir does not choose a
nearby or recent conversation, open a picker, or substitute a fresh launch.

The provider owns transition semantics and exact provider identities. The PTY supervisor owns the
bounded and revocable observation lifetime, exact recovery identity, and structured-observation
relocation behind `ProjectHost`. `TerminalPane` remains provider-blind. Late, duplicated,
replayed, malformed, out-of-order, and stale-lifetime evidence cannot grant authority for another
action.

This exception does not authorize ambient agent dispatch, reactions to unrelated provider
activity, inferred slash commands, prompt delivery, conversation graphs, general lifecycle
control, or session orchestration. Side chats, subagents, rewind, resume, clear, and unrelated
identity transitions are outside it.

## Consequences

The native fork gesture can be the complete user intent for one preserved-conversation terminal;
hvir need not require a second gesture when every exact provider condition qualifies. The scope is
small enough to preserve hvir's view-first terminal ergonomics rather than introduce a general
conversation manager.

Provider support is conditional, versioned capability rather than a claim implied by this record.
If no provider condition supplies both an exact fork transition and concurrent exact resume, this
decision enables no runtime behavior. Provider qualification methods and results remain in a
separate evaluation document rather than this durable decision.

A later implementation must update recovery identity and structured observation as one
generation-aware PTY transition. It must retain the existing local/SSH, provider, terminal, and
host ownership seams and add no detection daemon or persistent provider configuration.

## Rejected alternatives

- Always require a second hvir gesture: safe but needlessly repeats intent when the provider can
  establish the exact fork and preserved conversation.
- Treat any conversation-identity change as a fork: unrelated transitions would start terminals
  without the user's qualifying intent.
- Infer the slash command from terminal input, output, history, titles, or notifications: terminal
  presentation is neither provider authority nor an exact structured recovery boundary.
- Select an artifact by cwd, path, creation time, or recency: concurrent sessions make those
  relationships ambiguous.
- Add an App Server, helper daemon, or persistent provider configuration solely for detection:
  that would enlarge launch, transport, authentication, and cleanup lifecycles for one ergonomic
  feature.
- Model a conversation tree or general provider transition graph: the product need is one bounded
  sibling recovery, not session orchestration.
