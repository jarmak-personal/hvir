---
name: write-hvir-tests
description: Design, change, diagnose, or review hvir tests at the behavior's lowest real owning seam. Use for test additions, fixture work, altitude selection, flake diagnosis, lifecycle and cleanup proofs, local/SSH parity, and test-focused review.
---

# Write hvir tests

Choose evidence from the behavior and its owner, not from the nearest framework or existing test
file. Preserve hvir's real Electron, Chromium, node-pty, system Git, packaging, capacity, and SSH
contracts while keeping pure policy cheap and direct.

This skill owns test-design procedure. It does not select Git branches, worktrees, issue scope, or
pull-request lifecycle; use `hvir-implement-issue` for those implementation responsibilities.

## Establish the behavior and owner

Before choosing a test file or framework:

1. Read `AGENTS.md`, `docs/design.md`, the governing issue, and the ADRs that own the behavior.
2. State the user or contributor-visible contract in one sentence. Separate it from the current
   implementation and from incidental DOM, log, class-name, timing, or call-order observations.
3. Trace the production path through its actual owners. Inspect renderer models and effects,
   preload/IPC adapters, main coordinators, workers, `ProjectHost`, the PTY supervisor, harness
   providers, `TerminalPane`, and external boundaries only where they participate.
4. Name the policy owner, effect/resource owner, public seam, and immediate external dependency.
5. Search by behavior as well as symbol name for existing tests, domain fixtures, fake ports,
   production events, semantic snapshots, cleanup owners, clocks, deferred completions, and
   scenario groups.

When the task selects or reviews test altitude, read
[`references/behavior-altitude-matrix.md`](references/behavior-altitude-matrix.md) completely
before editing tests. Use it as a stable owner/evidence map, not as an inventory or migration
ledger.

Stop for alignment when the requested test would change product behavior, create test-only
authority, weaken an accepted security or lifecycle contract, or replace a required real
environment with a fake. Otherwise record the selected behavior, owner, lowest real altitude,
and any deliberately retained higher-altitude contract before editing.

## Select the lowest real altitude

Use the lowest layer that still contains the contract:

- Test pure planners, parsers, reducers, selectors, validators, and state machines directly.
- Test feature consumers through narrow fake ports. Assert their public state, commands, and
  resource semantics rather than private collaborator calls.
- Test adapters by faking only their immediate external dependency. Preserve public authority,
  validation, failure, cancellation, and cleanup behavior.
- Use main-process Electron scenarios for Electron lifecycle or native-ABI contracts that do not
  require a renderer.
- Use focused renderer scenarios for Chromium, CodeMirror, terminal-canvas, guest, cross-process,
  reload, destruction, geometry, or paint behavior.
- Use native-package, controlled-capacity, deterministic SSH-transport, or real-host acceptance
  only when that environment is itself the contract.

Do not move stable coverage merely to satisfy an inventory. Re-home it only when current evidence
shows that it is flaky, masks unrelated behavior, costs materially too much, or runs above its
owning seam. When two altitudes prove different contracts, retain both and state the distinction.

## Reuse production lifecycles

- Subscribe to the production event or semantic state before the action that can emit it.
- Prefer observable production readiness over sleeps, frame counts, registry polling, or
  unrelated DOM. A bounded wait is a timeout and diagnostic boundary, never readiness itself.
- Use fresh host-qualified project and user-data roots. Never default a remote test to an ambient
  host, path, credential, agent, port, profile, or developer configuration.
- Keep clocks, deferred completions, probes, and fakes domain-owned. Add one only when its owning
  feature has a representative consumer.
- Model partial startup explicitly. Register cleanup as each resource is acquired, dispose
  children in reverse order, make disposal idempotent, and preserve the original failure.
- Revoke owner and request generations before releasing their descendants. Prove that late async
  completion fails closed and cannot recreate state or authority.
- Exercise success, expected failure, partial startup, interruption, and destruction at the seam
  that owns those outcomes. Do not claim in-process cleanup after `SIGKILL`.
- Keep diagnostics bounded and content-free. Never retain terminal transcripts, source or diff
  bodies, credentials, authentication answers, request bodies, cookies, headers, forms, DOM,
  arbitrary console text, raw environment values, or unreviewed screenshots.

## Preserve local and SSH truth

Paths remain `(host, path)` values in fixtures and assertions. Pure host-neutral policy may use a
narrow host-qualified fake. Deterministic `SshHost` and transport tests prove authority, pooling,
reconnect, failure, and cleanup without claiming real server behavior. Real-host acceptance is
explicitly configured, confined to a disposable registered root, secret-safe, and separate from
normal pull-request verification. A synthetic SSH badge or renderer label is presentation
evidence only.

## Diagnose flakes without retries

Reproduce one named scenario with fixed inputs and a fresh process, project root, and user-data
root. Record the last safe semantic state, owned-resource summary, process outcome, and bounded
application evidence. Vary one suspected boundary at a time. Repetition is stress evidence: run
every scheduled iteration and fail the aggregate if any iteration fails. Never turn automatic
retry or an unchanged rerun into a passing result.

## Review the candidate

Check that each assertion proves the named behavior at its selected altitude; fakes stop at the
immediate boundary; security and failure paths remain public; subscriptions precede actions; and
cleanup covers partial startup, destruction, and late completion. Reject test-only production
branches, alternate composition roots, generic fixture frameworks, global registries, service
locators, and exported internals created only for assertions. Record temporary duplicate coverage,
known gaps, and migration or acceptance evidence in the governing issue or pull request, never in
this skill or its matrix.

Run focused checks while iterating. Run `npm run verify` after the final change. Use the focused
Electron group, supported macOS command, installed-package check, capacity gate, stress command,
or real-host acceptance command when the governing contract requires it. Report exact evidence
and unavailable environments honestly; never imply a skipped check passed.
