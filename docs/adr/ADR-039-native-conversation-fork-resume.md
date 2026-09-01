# ADR-039: Let one native fork authorize one exact sibling branch

## Context

A native harness fork leaves two useful continuations that share the conversation before the
fork. Keeping both available in adjacent hvir terminals removes a repetitive launch-and-selection
step. Automatically starting another harness still requires narrow authority: an apparent
identity change, a recent artifact, or a terminal command-shaped string is not enough.

Preserving the provider's original identity is preferable, but it is not the product invariant.
Some providers prevent the original from being resumed while the native fork remains live, yet
can create another exact child from the same provider-owned history boundary. The user outcome is
two exact, independently writable continuations, not a particular identity graph.

No single evidence source has to prove the complete relation. The terminal engine can know what
the user submitted without knowing provider identities. Provider artifacts and native commands
can know identities and ancestry without knowing which hvir PTY received the gesture. PTY and
host owners can bind those facts to one launch lifetime without owning provider semantics.

## Decision

One explicit supported native conversation-fork gesture in a current hvir-owned live terminal
may authorize exactly one automatic exact provider branch that shares the same provider-owned
pre-fork history. The additional branch may be the preserved original or an equivalent sibling
created from the same exact history boundary. The existing terminal remains on the provider's
native result. Both terminals must have exact recovery identities, accept independent later
messages, and never interleave conversation writes.

Authority requires three separately qualified facts:

1. **User intent.** A terminal-engine contract may establish only that direct user input submitted
   the exact supported fork gesture in one current PTY generation. It may compare the already
   forwarded input with one bounded command matcher, but must retain only constant-size progress
   and origin state, discard every nonmatching byte immediately, and publish no command,
   composer, screen, or general terminal text. Paste, composition, editing, completion, replay,
   repeated submission, ambiguous startup state, and an engine that cannot distinguish direct
   keys fail closed. Input is observed, never intercepted, suppressed, rewritten, or replayed.
2. **Provider identity and ancestry.** A trusted bundled provider must establish every
   conversation identity and the exact shared-history relationship from provider-owned metadata,
   a structured provider status, or an exact native command result. Terminal evidence, titles,
   cwd, timing, filenames, and recency never establish identity or ancestry.
3. **PTY association.** The PTY supervisor and `ProjectHost` bind the admitted gesture and
   provider result to the exact host-qualified workspace, provider/profile launch revision,
   registered current identity, descendant process or launch-scoped status source, and PTY
   generation. Exactly one qualifying result may consume the authority. Missing, competing,
   malformed, oversized, late, replayed, or stale-lifetime evidence revokes it.

The one automatic action uses only the provider's picker-free exact resume or fork mechanism. It
never chooses a recent conversation, opens a picker, uses an ambient latest session, or substitutes
a fresh launch. Each provider version, artifact configuration, terminal engine, and host condition
is a separately versioned capability. Local qualification does not imply SSH qualification.

`TerminalPane` remains provider-blind and may expose only engine-neutral input-origin categories;
the main-owned provider performs the bounded gesture match. Observation, candidate parsing, and
process association remain off the renderer thread, use `ProjectHost`, and end with the PTY or
host lifetime. The provider's configured artifact root and existing observer ownership are reused;
no daemon, installed remote helper, or persistent hidden provider configuration is introduced.

This is a narrow exception to the prior blanket rejection of terminal input inference: terminal
input may prove the exact submitted fork gesture and nothing else. It does not authorize ambient
agent dispatch, general slash-command interpretation, prompt delivery, conversation graphs,
automatic terminal teardown, or general session orchestration. Side chats, subagents, rewind,
resume, clear, and unrelated identity transitions remain outside it.

## Consequences

One native fork gesture can be the complete user intent for two adjacent exact continuations when
all three evidence owners qualify. A provider that blocks concurrent resume of the original may
still qualify through an exact equivalent sibling, so exact A/B identity preservation is no longer
the gate.

Provider support remains conditional rather than implied by this record. The volatile provider,
artifact, engine, and host matrix belongs in the evaluation document. Unsupported input forms or
host conditions continue normal native behavior and create no extra terminal.

A runtime implementation must keep one bounded, revocable authority per PTY generation and update
the source terminal's recovery identity and observer atomically after the provider transition. The
additional terminal then starts through ordinary provider/profile and PTY-supervisor composition.
Failure is visible and leaves the native terminal untouched.

## Rejected alternatives

- Require concurrent exact resume of the original identity: this rejects providers that can
  produce two exact equivalent children from the same history.
- Treat any identity change or newly created child artifact as a fork: neither proves the user's
  gesture or the current PTY relation.
- Parse terminal cells, retained ranges, titles, or output: those sources contain presentation or
  conversation content and do not own provider identity.
- Retain a command buffer or interpret arbitrary slash commands: the authority is one constant-size
  matcher for one provider-qualified gesture, not a terminal activity log.
- Select by cwd, filename, timestamp, or recency: concurrent sessions and external forks make
  proximity ambiguous.
- Add Codex App Server, `codex --remote`, a helper daemon, or persistent provider configuration:
  those enlarge transport, authentication, and cleanup lifecycles for one ergonomic action.
- Automatically terminate or restart the source terminal: that requires separate user authority
  and lossless state proof.
- Model a conversation tree or general provider transition graph: the product need is one bounded
  sibling continuation per explicit gesture.
