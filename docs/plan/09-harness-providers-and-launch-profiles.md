# Phase 9 — Harness providers & launch profiles

**Status:** Implementation complete; real-host and Milestone 0 soak acceptance pending.

Implementation proceeded on an explicitly authorized feature branch while the Phase 8 gate
remains open. The exception permits implementation and automated verification only; it does
not waive or pre-approve the outstanding local/SSH acceptance evidence below.

**Read first:** [`00-overview.md`](00-overview.md); design.md §2–3, ADR-003
(`TerminalPane`), ADR-006 (exact harness recovery), ADR-009 (provider-independent
attention), ADR-010 (`ProjectHost` and host-qualified paths), and ADR-012 (provider
registry and launch profiles).

## Goal

Let any terminal harness launch through a user-configurable profile while preserving the
deeper guarantees that make a bundled provider first-class: exact session recovery,
truthful capability reporting, optional structured telemetry, local/SSH parity, and no
harness behavior outside the provider seam.

After this phase, adding a bundled launch-only provider changes one provider module and its
tests rather than shared IPC unions, renderer labels, and persistence parsing. Users can
create profiles that add flags, environment bindings, executable overrides, and explicit
host-qualified path bindings without falling back to a plain shell. Claude Code and Codex
retain current recovery/telemetry behavior, and Pi, Gemini CLI, GitHub Copilot CLI, and
Cursor CLI are evaluated for verified launch profiles with only the capabilities their
installed version can actually support. At least three of those four candidates ship in the
phase; one may be deferred with recorded evidence and concrete re-entry criteria rather than
holding the provider foundation open indefinitely.

The full v2 harness viewer remains parked. This phase builds the catalog and observation
contract it will consume; it does not build that tab.

## Product behavior

- The New terminal menu lists **launch profiles**, not hard-coded adapter IDs. Built-in
  defaults preserve the current Shell, Claude Code, and Codex one-click choices.
- A provider describes a harness; a profile describes how this user wants to launch it.
  Multiple profiles may reference one provider, such as `Claude Code`, `Claude Code —
  bypass permissions`, and `Claude Code — plan`.
- `Configure harnesses…` opens a focused profile editor for name, provider, executable,
  argv, environment bindings, scope, and path bindings. Before Save it shows the effective
  fresh/resume commands, including plaintext literals and redacting only secret references.
- Profiles may be global or scoped to one registered host-qualified project. Global
  profiles may use `{projectRoot}` and `{workspaceRoot}`; explicit absolute bindings are
  stored as `HostPath` and cannot be applied to another host accidentally. A binding outside
  the project requires an explicit host-folder selection and grants the path to the launched
  harness without widening ordinary renderer file access.
- A Custom command provider launches an arbitrary structured executable + argv profile
  immediately, with Shell-level lifecycle only. It never claims recovery or harness
  telemetry.
- Main probes availability and effective capabilities per host/profile launch revision. The
  menu distinguishes available, executable missing, version incompatible, probe failed, and
  unchecked. A slow or disconnected host never delays workbench paint.
- Profiles that request a provider-known permission/sandbox bypass are marked **Elevated**;
  Custom profiles and provider options whose risk is not understood are **Unclassified**.
  Their warning and auto-restore choice are explicit and tied to the launch revision.
- A missing provider/profile or edited launch revision leaves a recovery record visible but
  blocks silent auto-restore. Renaming, describing, or reordering a profile does not. The
  user can review the current profile, rebind it only within the same provider, or forget it;
  hvir never substitutes a different provider or command.
- Existing exact-session rules remain absolute. `latest`, title matching, cwd-only matching,
  and TUI scraping are never recovery fallbacks.

## Expected provider directions — verify before implementation

This table is a research queue, not a CLI contract. Re-run official documentation and
host-side `--version`/`--help` checks when implementing each provider, record the versions
and evidence in this document, and encode only verified behavior.

| Provider | Expected launch/recovery direction | Fail-closed fallback |
|---|---|---|
| Plain shell | Host default shell; no harness identity | Fresh shell |
| Claude Code | Preassign UUID; exact resume; transcript observer | Launch unavailable if required session flags disappear |
| Codex | Bounded exact rollout discovery; exact resume; rollout observer | Launch with recovery/telemetry visibly unavailable |
| Pi | Verify whether exact `--session` can safely create/preassign; otherwise discover one exact session artifact | Launch-only profile |
| Gemini CLI | Verify full-ID resume and bounded machine-readable session listing/artifacts | Launch-only profile |
| GitHub Copilot CLI | Use preassigned `--session-id` only on versions that actually expose its create/resume semantics | Launch-only on older versions; never ambient `--continue` |
| Cursor CLI | Verify exact-ID listing/resume and a trustworthy new-session discovery source | Launch-only profile while beta surfaces are insufficient |

## Implementation checklist

### Milestone 0 — Provider-registry parity gate

This milestone lands and soaks as an isolated zero-behavior-change refactor before profile
persistence, command customization, probes, additional providers, or the telemetry-envelope
migration begins. It is a hard checkpoint: all existing Shell, Claude Code, and Codex
launch/resume commands, exact identities, context meters, terminal records, local/SSH
behavior, and UI labels must remain equivalent. Do not combine this checkpoint with the
later profile schema migration in one change.

- [x] Introduce the minimal `HarnessProvider`, `HarnessManifest`, registry, and serializable
      catalog descriptor needed to represent the three existing adapters. Evolve
      `HarnessAdapter` in place or provide a short internal compatibility layer; do not add
      profiles, probes, new providers, or a second PTY launch seam in this milestone.
- [x] Model session identity as a discriminated provider capability (`none`,
      `preassigned`, `discovered`) with the existing snapshot/identify hooks available only
      to `discovered` providers. Exact resume remains a separate effective capability.
- [x] Build a main-owned registry with explicit registration, duplicate-ID rejection,
      bounded provider ID syntax, catalog enumeration, and lookup. Provider modules are
      trusted bundled code imported by main.
- [x] Replace the shared `TerminalAdapterId` closed union with an opaque validated provider
      ID. Remove hard-coded provider enumeration from shared IPC, the renderer, and the
      terminal registry parser.
- [x] Version and migrate the existing terminal registry from `adapterId` to `providerId`
      without adding profile identity yet. Preserve terminal IDs, exact harness IDs, cwd,
      project, title, layout, and authorization behavior; retain an old-file rollback fixture.
- [x] Add minimal typed catalog IPC for the three existing providers' display metadata and
      current static capabilities. It exposes no profile, probe, risk, environment,
      credential, adapter-private discovery, or executable-command data.
- [x] Make the renderer derive labels, context-meter presentation, and new-terminal choices
      from catalog capabilities instead of `claude-code`/`codex` conditionals. Wire title
      normalization through the provider hook or remove the currently unused hook.
- [x] Preserve unknown-provider recovery records during load/save. Mark them orphaned and
      unavailable; never filter them out merely because the current build lacks a provider.
- [x] Extend seam enforcement so only the provider registry resolves provider modules and
      only the PTY supervisor calls `ProjectHost.spawnPty`.
- [x] Add byte-for-byte launch/resume composition parity tests for Shell, Claude Code, and
      Codex plus registry migration, recovery authorization, telemetry, local/SSH, and
      renderer-label coverage. Run the full Phase 6/7.5 recovery/capacity suites.
- [ ] Land this milestone independently and complete a local/SSH soak with restored Claude
      and Codex sessions before checking the gate. Record evidence here; every later
      milestone keeps this parity suite green.

### Milestone 1 — Launch profile model and persistence

- [x] Define a versioned `HarnessProfile` schema with a stable ID and monotonic
      `launchRevision` covering provider ID and launch-contract version, scope, executable,
      argv, environment/path bindings, and derived risk. Increment it only when that
      normalized identity changes, including a bundled provider contract/risk-rule upgrade.
      Store cosmetic display name, description, and menu order separately (with an independent
      metadata revision if optimistic concurrency needs one). Cosmetic edits and no-op Saves
      never bump `launchRevision`, invalidate recovery, or reset risk acknowledgment; bind
      restore policy and risk acknowledgment only to `launchRevision`.
- [x] Distinguish an executable command name from an absolute executable `HostPath`.
      Validate command names, host identity, absolute paths, string/count/byte bounds,
      control characters, and duplicate environment keys in main.
- [x] Support only fixed path tokens (`{projectRoot}`, `{workspaceRoot}`, and named profile
      bindings). Expand tokens as complete argv values or explicitly typed value fragments;
      reject unknown tokens, `$...`, command substitution, glob expansion, and cross-host
      bindings.
- [x] When a global profile requires `{projectRoot}` or `{workspaceRoot}` without matching
      active context, keep it listed as unavailable with `Requires an active project` or
      `Requires an active workspace`; reject launch before PTY creation rather than treating
      the token as an empty string or validation-corrupting the stored profile.
- [x] Represent an explicit outside-project path binding as a main-owned launch grant created
      by a local/SSH folder-selection gesture. Revalidate its host and canonical target when
      launching, and do not add it to renderer viewer/file IPC authority.
- [x] Define environment bindings as discriminated set-literal, named-reference, and unset
      operations. Validate POSIX environment names, make local-to-remote forwarding an
      explicit source, remove unsets before the interactive shell starts, and never obtain
      values by evaluating a shell expression. Document that shell startup files may set an
      unset name again.
- [x] Keep plaintext environment literals out of renderer `localStorage`, the recovery
      registry, logs, analytics, and catalog IPC. Mark their local app-metadata storage as
      plaintext in the UI. Store secret bindings only by reference to a supported credential
      source; if no secure source is available, make them session-only and incompatible with
      unattended restore.
- [x] Persist profiles in versioned local app metadata through the local `ProjectHost`, with
      atomic writes, bounded records, corruption recovery, and deterministic built-in
      defaults. Do not write hvir profile configuration into the user's repository.
- [x] Provide CRUD plus duplicate/reorder operations through typed, main-validated IPC.
      Built-in defaults are immutable; users customize by duplicating them. Rename,
      description, and reorder operations update only cosmetic metadata.
- [x] Decide deletion semantics explicitly: deleting an in-use profile preserves affected
      terminal records as missing-profile records until the user rebinds within the same
      provider or forgets them. Do not offer a cross-provider rebind action.
- [x] Implement the Custom command provider with no identity, resume, title convention, or
      structured telemetry claims and an always-`unclassified` risk label.

### Milestone 2 — Deterministic launch composition

- [x] Give each provider an explicit profile-argument insertion point when building fresh
      and resume argv. Provider-owned session selectors and required title/telemetry flags
      cannot be removed, duplicated, or reordered by a normal profile.
- [x] Validate provider-specific reserved flags and subcommands. If a user needs to replace
      session semantics, require a Custom command profile and downgrade capabilities rather
      than retaining a false recovery badge.
- [x] Add a provider-owned risk classifier over the resolved executable, structured argv,
      environment bindings, and config overrides. Its exact-match rules cover known aliases,
      separate and `--flag=value` forms, environment keys, and forms such as `-c key=value`.
      Return `standard`, `elevated`, or `unclassified`; Custom profiles and unrecognized
      extra tokens are never assumed standard. Document that classification is best-effort
      warning/restore policy, not a security boundary.
- [x] Add provider declarations for artifact-relevant executable state, environment/config
      keys, and path bindings, plus provider-reserved names. Derive an `artifactIdentity`
      only from those resolved inputs for discovery/telemetry. A reserved binding with no
      declared artifact semantics raises a validation warning and disables structured
      discovery/telemetry for that profile until the provider handles it.
- [x] Centralize environment precedence:
      host process/session environment → provider defaults → profile bindings → hvir's
      protected `TERM`, `COLORTERM`, and `TERM_PROGRAM` values. Reject attempts to override
      protected keys in a profile. Apply explicit unsets after inherited/provider values and
      before the protected terminal contract.
- [x] Preserve interactive-shell executable resolution for version-manager/user-profile
      PATHs. Continue to quote each executable/argv element independently and `exec` the
      resolved command; never pass profile text to `sh -c` as an opaque command.
- [x] Add a main-owned command-preview operation that returns separate executable/argv/env
      metadata plus a human-readable rendering for both fresh and resume modes. Show
      plaintext non-secret literals exactly as stored; redact only reference-sourced secret
      values and say so. Preview and actual spawn call the same pure composition function.
- [x] Change `pty:start` to identify a profile and expected `launchRevision`. Main resolves the
      provider/profile against the active host-qualified workspace and passes only the
      resolved trusted launch configuration into the PTY supervisor.
- [x] Keep PTY creation, output replay, ownership, resize/write/kill, attention, and
      `TerminalPane` behavior unchanged above and below the resolved launch spec.

### Milestone 3 — Profile-bound recovery and migration

- [x] Version the terminal-session registry and persist provider ID, profile ID,
      `launchRevision`, exact harness session ID when known, host-qualified project/cwd, title,
      position, and active state. Do not persist resolved argv/env snapshots.
- [x] Migrate existing `plain-shell`, `claude-code`, and `codex` records to their immutable
      default profiles without changing terminal IDs or exact harness IDs. Keep a rollback
      fixture for the previous file version.
- [x] Bind resume authorization to terminal ID, provider ID, profile ID/`launchRevision`,
      exact harness session ID, project root, and cwd. A changed launch revision or same-
      provider rebind requires an explicit registry update before resume; cosmetic edits do
      not. Reject cross-provider rebind because its exact harness session ID is not portable.
- [x] Apply the same profile to fresh launch, manual restart, exact resume, renderer reload,
      and SSH reconnect. A reconnect cannot silently fall back to the provider default or a
      fresh harness when exact identity/profile authorization is missing.
- [x] Skip automatic restoration for missing, launch-changed, session-only-secret,
      elevated-without-current-acknowledgment, or unclassified-without-current-
      acknowledgment profiles. Bind acknowledgment to `launchRevision`, not cosmetic
      metadata. Present one calm recovery decision rather than launching and then killing a
      mismatched command.
- [x] Preserve the Codex discovery queue's `(host, provider)` serialization and bounded
      fail-closed scan. Supply provider-declared `artifactIdentity` to discovery and telemetry;
      never substitute the whole launch revision or let each observer rediscover which
      bindings affect its artifact location.
- [x] Cover races between profile edits/deletion, pending probe, pending PTY spawn, identity
      discovery, window teardown, host disconnect, and session-registry persistence.

### Milestone 4 — Per-host availability and capability probes

- [x] Give each bundled provider a bounded probe that runs through `ProjectHost`, resolves
      the same interactive-shell environment as launch, captures bounded output, observes an
      abort signal/deadline, and returns structured status without throwing through IPC.
- [x] Cache probes by host, provider, profile ID/`launchRevision`, and connection generation
      (or by an equivalent normalized probe-input fingerprint). Coalesce duplicate requests;
      invalidate on reconnect, launch edits, and an explicit Refresh action. Expire available
      results after ten minutes and negative/error results after two minutes; opening the menu
      re-probes stale entries in the background.
- [x] Let a provider-classified executable-not-found, unsupported-option, or version launch
      failure invalidate its probe immediately and schedule one bounded refresh. Do not
      retry arbitrary harness failures or create a PTY restart loop.
- [x] Keep probes out of renderer startup and first paint. Populate the menu immediately
      from cached/unchecked descriptors and update availability asynchronously.
- [x] Distinguish executable missing, version unsupported, capability absent, authentication
      needed, disconnected, timeout, and malformed probe output where the provider can do so
      truthfully. Never convert an unknown result into support.
- [x] Test two hosts with different versions of the same provider. The provider/profile ID
      remains stable while effective recovery/telemetry capabilities differ per host.
- [x] Bound concurrent probes per host so opening the New terminal menu cannot exhaust SSH
      control channels or starve Git/files/watch operations.

### Milestone 5 — Profile and terminal UX

- [x] Replace the hard-coded New terminal menu with ordered profile rows showing name,
      provider, host availability, elevated/unclassified status, and the strongest supported
      recovery/telemetry summary. Keep the plain Shell default one action away.
- [x] Add `Configure harnesses…` to Settings with profile list, create/duplicate/edit/delete,
      global/project scope, provider selection, executable, argv editor, environment rows,
      path-binding picker, risk disclosure, and fresh/resume previews.
- [x] Use the existing local/SSH folder browsing and `HostPath` confinement flow for explicit
      path bindings. Do not use an OS-local picker for a remote profile, and make an
      outside-project selection visibly distinct from changing the active workspace.
- [x] Explain provider-reserved flags inline. Validation errors identify the conflicting
      flag/token without silently deleting or rearranging user input.
- [x] Show the profile name and Elevated/Unclassified marker in the terminal rail while
      retaining the provider label and existing status/attention language; Custom is the
      provider label, while Unclassified is its risk state.
- [x] Update restore prompts to show provider + profile, launch-revision mismatch, capability
      loss, missing executable/provider, and elevated/unclassified status before the user
      approves a launch. Cosmetic metadata changes never create a mismatch prompt.
- [x] Keep keyboard navigation, focus clearing, menu dismissal, screen-reader names, and
      narrow-rail behavior usable with long profile/provider names.

### Milestone 6 — Bundled provider expansion

- [x] Keep the Milestone 0 Shell/Claude/Codex parity suite green while adding providers; do
      not mix provider expansion with further terminal-registry or launch-pipeline refactors.
- [x] Resolve the Pi candidate: ship a verified provider/default profile, or use the one
      permitted provider deferral with recorded CLI/version evidence and re-entry criteria.
      Prefer exact preassignment only if the installed CLI proves that a caller-supplied ID
      creates the intended session; otherwise implement bounded artifact discovery or
      advertise launch-only.
- [x] Resolve the Gemini CLI candidate: ship a verified provider/default profile, or use the
      one permitted deferral. Use only full exact IDs and a bounded, project-qualified
      discovery source; never `latest` or an interactive picker for hvir recovery.
- [x] Resolve the GitHub Copilot CLI candidate: ship a verified provider/default profile, or
      use the one permitted deferral. Capability-gate preassigned `--session-id`; older
      installed versions remain launchable without exact recovery unless a separate exact
      discovery strategy is proven.
- [x] Resolve the Cursor CLI candidate: ship a verified provider/default profile, or use the
      one permitted deferral. Keep it launch-only until an exact, bounded, machine-readable
      identity path is demonstrated.
- [x] Ship at least three of the four candidate providers above. At most one may be marked
      deferred, with the exact missing/unstable surface, tested version, fallback Custom
      profile instructions, and a concrete condition for revisiting it in Implementation
      evidence. A truthful launch-only provider counts as shipped.
- [x] For every provider, capture versioned launch/resume/probe fixtures and adversarial cases
      (missing fields, ambiguous sessions, concurrent same-cwd launches, incompatible help
      output). Provider-specific parsing remains inside its module.
- [x] Do not add context/cost/configuration telemetry merely because a human-readable TUI
      displays it. Add a facet only from a trustworthy protocol, provider extension, or exact
      session artifact with bounded parsing and cleanup.

### Milestone 7 — Harness-tab telemetry foundation

- [x] Replace the narrow context-only payload with a versioned `HarnessSnapshot` envelope
      containing observation time, source/provenance, freshness, and optional normalized
      facets. Migrate the existing context meter without changing its thresholds or visible
      semantics.
- [x] Define initial normalized facets for exact session state, model, context pressure,
      usage/cost, turn/approval state, and loaded skills/MCPs. Each facet distinguishes
      unsupported, unavailable, stale, and available; absent data is never rendered as zero.
- [x] Allow bounded namespaced provider data for facts without honest common semantics.
      Validate it as serializable data with size/depth limits; it cannot inject renderer UI.
- [x] Keep generic PTY attention independent from provider turn-state facets. A provider may
      enrich a future harness tab but cannot suppress or manufacture the ADR-009 attention
      state through screen heuristics.
- [x] Reuse the existing per-`(host, provider)` telemetry hubs, generation reconciliation,
      frame bounds, subscription cleanup, and SSH control-channel reservation. Profile churn
      must not create one follower/channel per terminal. Reconcile subscriptions when the
      provider-declared `artifactIdentity` changes; cosmetic and artifact-irrelevant launch
      changes leave the shared channel intact.
- [x] Add a small internal/catalog inspection surface for tests and diagnostics only. The
      user-facing full harness viewer remains a separate future phase and ADR addendum if its
      information architecture changes.

### Milestone 8 — Verification and hardening

- [x] Unit-test registry enumeration, duplicate IDs, opaque-ID IPC validation, dynamic labels,
      unknown-provider record preservation, and absence of harness IDs outside provider
      modules/fixtures.
- [x] Unit-test profile schema migration, corruption bounds, launch-vs-cosmetic revision
      behavior, same-provider rebind, cross-provider rejection, scope, deterministic
      ordering, and atomic persistence.
- [x] Property/fuzz-test argv quoting and preview/spawn equivalence with spaces, quotes,
      newlines/control rejection, leading dashes, Unicode, empty values, and shell metacharacters.
      Run the same cases through local and SSH command construction.
- [x] Test environment precedence, explicit unset, protected keys, literal-preview wording,
      secret redaction, local/remote source distinction, and prove reference-sourced secret
      values never enter catalog IPC, logs, previews, or recovery files.
- [x] Test path-token expansion and reject unknown tokens, cross-host values, relative explicit
      paths, unapproved outside-project bindings, canonical-target changes, and unbounded
      argument/path counts. Prove a valid outside-project launch grant does not expand renderer
      read/write authority.
- [x] Test every recovery identity mode, reserved session flags, launch-revision mismatch,
      cosmetic-edit continuity, elevated/unclassified auto-restore gating, provider
      capability downgrade, missing executable, and ambiguous discovery. No case may resume
      ambient latest state.
- [x] Test artifact-identity declarations, artifact-relevant and irrelevant profile changes,
      reserved-but-undeclared binding warnings/fail-closed observers, correct session routing,
      and no unnecessary telemetry-channel restart.
- [x] Test probe timeout/cancellation/cache invalidation, positive/negative TTLs, menu-open
      stale refresh, classified launch-failure refresh, two-host version skew, SSH reconnect,
      channel-pressure bounds, stale response rejection, and menu responsiveness.
- [x] Extend the production Electron smoke with local structured args/env, a host-qualified
      path binding, a Custom command profile, migrated Claude/Codex defaults, profile command
      preview, restore/reconnect, and PTY cleanup.
- [ ] Run one real local and one real SSH pass for every shipped bundled provider. Record
      executable/version, effective capabilities, launch result, exact recovery result where
      supported, telemetry source, and teardown evidence without recording credentials or
      transcript contents. Record equivalent research evidence for the one permitted deferral.
- [x] Run seam enforcement, lint, both TypeScript builds, focused/full tests, production smoke,
      and the Phase 8 responsiveness gauntlet. Provider probing/profile UI must not regress
      the existing paint and terminal-output latency bounds.

## Acceptance criteria

- [ ] Existing Shell, Claude Code, and Codex menu actions launch the same effective defaults
      and retain their current local/SSH recovery and context behavior. This parity was
      landed and soaked as Milestone 0 before profile work began.
- [ ] A user can create and launch profiles equivalent to:
      `claude --dangerously-skip-permissions`,
      `codex --add-dir <host-qualified-path>`, and
      `SOME_ENVIRONMENT_VARIABLE=value claude`, locally and over SSH, without first opening a
      plain shell.
- [x] Adding a launch-only provider requires one provider module/registration and tests; it
      requires no shared ID union, renderer label conditional, persistence parser branch, or
      terminal-engine change.
- [x] A Custom command profile launches an unknown future CLI through the PTY supervisor and
      accurately shows no recovery/structured telemetry support.
- [x] Different hosts can report different availability/capabilities for the same profile,
      stale local/remote results refresh under the documented TTL/launch-failure policy, and
      a slow probe never blocks initial paint, menu interaction, or a known launch.
- [x] Profile args/env/path values are structured, bounded, correctly quoted on local and SSH,
      support explicit unset, are previewed from the same composition path with honest
      literal/reference redaction, and are never evaluated as shell command text.
- [x] Recovery remains exact, same-provider, and bound to `launchRevision`. Missing or
      launch-changed profiles and elevated/unclassified unacknowledged profiles never
      auto-launch; cosmetic edits remain resumable, ambient latest is never used, and
      orphaned records are retained.
- [x] At least three of Pi, Gemini CLI, GitHub Copilot CLI, and Cursor CLI have verified
      bundled default profiles. Each advertises exact recovery or telemetry only where the
      tested installed version supplies a trustworthy source; launch-only is an accepted
      truthful result. At most one is deferred with recorded evidence and re-entry criteria.
- [x] Discovery and telemetry use provider-declared artifact identity. Artifact-relevant
      changes cannot observe the wrong session tree, while cosmetic and irrelevant launch
      changes do not churn the shared host/provider channel.
- [x] The versioned telemetry envelope carries provenance/freshness and renders existing
      context pressure without regression, while unsupported facets remain explicitly
      unavailable.
- [ ] Typecheck, lint, seam enforcement, full tests, production smoke, real-host matrix, and
      responsiveness checks pass; the Phase 9 status table is updated to `done`.

## Non-goals

A public extension host, marketplace, downloading or executing third-party provider code,
provider-contributed React/UI, a general credential vault, managing harness installation or
updates, changing harness authentication, replacing the native TUI with ACP/RPC/SDK rendering,
terminal-screen scraping, an installed remote helper, prompt queues/scheduling, worktree
orchestration, or the full v2 harness viewer. A later declarative provider package or
out-of-process provider SDK requires evidence from this phase and a separate ADR.

## Implementation evidence

### Milestone 0 — provider-registry parity checkpoint

- Isolated implementation commit: `b843341` (`refactor: introduce harness provider registry`).
- `npm run verify`: seam enforcement, lint, both TypeScript builds, launcher help, and all
  309 tests passed. The focused recovery/telemetry/SSH-capacity set passed 56 tests.
- `npm run smoke`: production Electron smoke passed, including catalog-driven Shell launch,
  reconnect, multiple-terminal rail behavior, recovery picker, and PTY cleanup. The first run
  reached all provider/terminal checks and later hit the existing source→diff line-position
  timing assertion; an unchanged rerun passed the complete smoke.
- `npm run smoke:capacity`: 12 live and recovered terminals passed with 18.7 ms p99 / 18.8 ms
  max frame gap, 75 measured interactions, and 108 MiB net memory growth.
- Local installed-version check: Claude Code `2.1.212`; Codex CLI `0.144.4`. No harness prompt,
  credential, transcript, or session artifact was created for this check.
- The final Milestone 0 gate remains open pending a real local/SSH restored Claude and Codex
  soak. Automated local/SSH transport and exact-recovery coverage is green, but it is not
  represented as real-host evidence.

### Completed implementation

- Profiles are stored in local app metadata with separate `launchRevision` and
  `metadataRevision` counters. Main owns validation, CRUD/duplicate/delete/order, atomic
  persistence, path grants, composition, previews, probes, and PTY resolution. Terminal
  recovery records are v3 and retain provider/profile/revision identity without resolved
  environment values.
- Fresh launch, exact resume, restart, reconnect, and restore use the same profile contract.
  Same-provider rebind is explicit; cross-provider rebind, ambient latest-session recovery,
  reserved session selectors, stale launch revisions, and unacknowledged elevated or
  unclassified restores fail closed.
- Probe results are keyed by host connection generation and launch revision, coalesced, and
  limited to two concurrent probes per host. Positive entries expire after ten minutes;
  negative/error entries after two. Menu-open stale refresh and one classified-launch-
  failure refresh are asynchronous and never retry a harness launch.
- The New terminal menu and focused Settings editor are catalog/profile driven. Structured
  argv, literal/reference/unset environment operations, host-qualified path selection,
  risk/capability state, and fresh/resume previews all flow through typed IPC. The production
  smoke launches a project-scoped Custom profile through the real preload, IPC, profile
  store, composer, and PTY supervisor before verifying output and teardown.
- Claude and Codex discovery/telemetry receive only provider-declared artifact identity.
  Bundled observer providers cannot register a reserved environment key without declaring
  its artifact semantics. The v1 `HarnessSnapshot` envelope carries provenance, freshness,
  normalized optional facets, and bounded provider data while preserving the existing
  context-pressure UI.

### Provider verification — 2026-07-17

Version/help checks were read-only and did not start a harness prompt or create credentials,
transcripts, sessions, or artifacts.

| Provider | Evidence checked | Shipped effective behavior | Re-entry criterion |
|---|---|---|---|
| Claude Code | Local `claude` 2.1.212 plus the retained parity fixtures | Preassigned exact UUID resume and bounded transcript telemetry | Fail closed if its required session surface changes |
| Codex | Local `codex-cli` 0.144.4 plus the retained parity fixtures | Bounded exact rollout discovery/resume and rollout telemetry | Fail closed if exact discovery or resume becomes ambiguous |
| Pi | Current [Pi coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md); executable absent locally | `pi` launch/probe only. The documented session selector identifies an existing session path/ID and does not prove caller-preassigned creation | Add exact recovery only after a version proves caller-supplied new identity or exposes a bounded exact artifact source |
| Gemini CLI | Local `gemini` 0.25.2 help and current [Gemini CLI documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/commands.md) | `gemini` launch/probe only. The installed resume surface offers ambient latest/index selection, which hvir rejects for recovery | Require a full exact ID plus a bounded, project-qualified listing or artifact source |
| GitHub Copilot CLI | Local `copilot` 0.0.394 help and current [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) | Always launchable. The probe advertises and composes exact preassigned `--session-id` only when that installed host's help exposes it; 0.0.394 therefore remains launch-only | The existing per-host probe upgrades capability automatically when the verified flag is present |
| Cursor CLI | Current [Cursor CLI installation documentation](https://docs.cursor.com/en/cli/installation); `cursor-agent` absent locally | `cursor-agent` launch/probe only while beta session surfaces lack a proven fresh-session identity | Require exact bounded machine-readable identity/listing and exact resume semantics |
| Custom | Internal structured-command contract | User-selected executable/argv/env/path launch through the PTY supervisor; always Unclassified, with no recovery or structured telemetry | Adopt as a bundled provider only after a reviewed provider contract exists |

All four candidates ship as truthful bundled defaults; none is deferred. Pi, Gemini, and
Cursor deliberately remain launch-only. Copilot capability varies per installed host and is
also launch-only on the locally checked 0.0.394 build. Launch-only providers declare no
speculative artifact-environment semantics.

### Automated verification

- `npm run verify`: seam enforcement, lint, both TypeScript builds, launcher help, and 349
  tests across 49 files passed.
- Focused profile/provider/probe/recovery/telemetry verification: 39 tests across six files
  passed after the final provider-contract cleanup.
- `npm run smoke`: the production Electron smoke passed, including migrated Claude/Codex
  defaults, structured Custom args/env/path preview, real PTY output, and cleanup.
- `npm run smoke:capacity`: 12 live/restored terminals, 75 measured interactions, 18.7 ms p99
  and 18.8 ms maximum frame gap, +21 MiB net / +33 MiB peak memory.
- `npm run gauntlet`: repeated verify, production smoke, and capacity successfully; the
  repeated capacity pass measured 18.7 ms p99/max with no positive memory-growth peak.
- Local and SSH transport tests cover structured quoting, explicit environment unset/set,
  bounded host execution, recovery identity, telemetry multiplexing, and PTY failure
  classification without requiring live credentials.

The five unchecked items above are intentionally acceptance-only: the isolated Milestone 0
real local/SSH Claude/Codex restore soak, the shipped-provider real-host matrix, the three
user-example local/SSH launches, and the final status transition. The user will perform that
acceptance testing on this branch; until its evidence is recorded, Phase 9 remains
`acceptance pending` rather than `done`.
