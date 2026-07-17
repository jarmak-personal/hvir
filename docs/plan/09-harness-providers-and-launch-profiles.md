# Phase 9 — Harness providers & launch profiles

**Status:** Acceptance refinement planned; original implementation complete, with real-host
and Milestone 0 soak acceptance still pending.

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
contract it will consume; it does not build that tab. In the compact terminal UI,
**hvir-integrated** is therefore a data-quality promise: hvir can correlate the PTY to one
exact provider session and continuously emit a bounded, provenance-bearing snapshot with
meaningful session state plus usage/context data. A provider module, version probe, exact
resume alone, or a human-readable TUI does not earn that label.

## Product behavior

- The provider registry is an integration catalog, not the user's terminal menu. A fresh
  profile store is empty, including Shell. The empty New terminal menu presents one primary
  `Add a harness…` action rather than materializing every registered provider automatically.
- `Add a harness…` probes the active host and offers detected provider templates as an
  initially unchecked multi-select. `Add manually…` can create a known-provider profile
  with a custom executable or a Custom command profile. This discovery flow never installs,
  updates, authenticates, or downloads a harness.
- Selecting a provider template creates an ordinary user-owned launch profile. A provider
  describes a harness; a profile describes how this user wants to launch it. Multiple
  editable, renameable, and deleteable profiles may reference one provider, such as
  `Claude Code`, `Claude unrestricted`, and `Claude Opus`; no permission or model preset is
  hard-coded into hvir.
- Upgrade compatibility is distinct from fresh-install defaults. When migrating legacy
  recovery records, materialize only the provider profiles those records reference (or keep
  them visibly rebindable) so existing exact sessions are not lost. A user with no prior
  harness state still starts with zero profiles.
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
  launch menu shows only configured profiles known to be launchable on the active host; it
  does not briefly render unchecked rows before a cold probe resolves. Settings retains
  configured-but-unavailable profiles with a repairable host-specific reason, because one
  global profile may be available locally and missing over SSH. The add flow hides
  undetected suggestions by default while retaining an explicit unavailable/manual path.
  A slow or disconnected host never delays workbench paint.
- Compact launch rows use only `Launch only` and `Integrated`. Availability is implicit in
  the filtered list, and the provider name is omitted when it duplicates the profile name.
  Settings/diagnostics retain the detailed exact-recovery, telemetry-facet, version, and
  probe status. `Integrated` requires exact host/project/session correlation plus a live
  structured `HarnessSnapshot` with at least one meaningful session-state facet and one
  trustworthy usage, cost, token, or context-pressure facet. Unsupported and stale data
  remain explicit; terminal-screen scraping never qualifies.
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

| Provider | Expected launch/recovery and observation direction | Fail-closed fallback |
|---|---|---|
| Plain shell | Host default shell; no harness identity or provider telemetry | Launch-only profile |
| Claude Code | Preassign UUID; exact resume; bounded transcript observer with verified session and usage/context facets | Launch remains available but is not labeled Integrated if identity or required telemetry disappears |
| Codex | Bounded exact rollout discovery; exact resume; bounded rollout observer with verified session and usage/context facets | Launch remains available but is not labeled Integrated if discovery or required telemetry becomes ambiguous |
| Pi | Snapshot its documented project-qualified JSONL session tree, discover one exact fresh UUID, resume with `--session <id>`, and verify bounded usage/context extraction | Launch-only profile until both exact correlation and the Integrated telemetry minimum are proven on a pinned version |
| Gemini CLI | Snapshot its documented project-qualified auto-saved chat artifacts, discover one full UUID, resume with `--resume <uuid>`, and verify its documented token-usage/session data | Launch-only profile until exact discovery, exact resume, and bounded telemetry pass pinned-version fixtures |
| GitHub Copilot CLI | Snapshot its documented `session-state/<id>` artifacts, discover one exact fresh ID, resume with `--resume <id>`, and verify bounded event-log usage/context extraction; never infer semantics from a help substring | Launch-only profile until a real installed release passes an explicit version gate and the Integrated telemetry minimum |
| Cursor CLI | Verify exact-ID listing/resume, a trustworthy fresh-session identity source, and a documented or otherwise version-pinned structured telemetry source | Launch-only profile while beta identity/artifact surfaces remain insufficient |

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
- [x] Keep profile evaluation and terminal launch behind the current invariant that an active
      workspace belongs to a registered project. Document the currently unrepresentable
      projectless/workspaceless case: if a future terminal surface removes that invariant,
      token-dependent profiles remain listed as unavailable and launch rejects before PTY
      creation rather than treating a token as an empty string.
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
      defaults. Do not write hvir profile configuration into the user's repository. This
      records the initial implementation; Milestone 9 retains the templates but stops
      materializing them into a fresh user's menu.
- [x] Provide CRUD plus duplicate/reorder operations through typed, main-validated IPC.
      The initial built-in defaults are immutable and users customize by duplicating them;
      Milestone 9 replaces that detour with normal user-owned profiles created from provider
      templates. Rename, description, and reorder operations update only cosmetic metadata.
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
      fixture for the previous file version. Milestone 9 changes only the materialization
      policy: referenced legacy defaults become user-owned profiles while fresh stores stay
      empty.
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
      recovery/telemetry summary. The initial implementation kept the plain Shell default one
      action away; Milestone 9 supersedes that fresh-install behavior with the opt-in add flow.
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

### Milestone 9 — Acceptance-driven profile and integration refinement

Acceptance testing found that the initial implementation exposed the registry as a menu of
immutable defaults and compressed the profile editor into the generic dialog width. This
milestone supersedes those product choices without weakening the provider, `ProjectHost`,
PTY-supervisor, recovery, or telemetry seams completed above. Keep its commits local until
the user finishes the expanded acceptance pass.

- [ ] Replace automatically materialized built-in profiles with provider-owned templates.
      A fresh install has zero launch profiles, including Shell; registry enumeration alone
      never creates a user-visible terminal action.
- [ ] Make the empty New terminal menu lead with `Add a harness…`. The add flow probes the
      active host, offers detected templates as an initially unchecked multi-select, and
      provides explicit known-provider executable override and Custom command paths. It does
      not install or authenticate a CLI.
- [ ] Materialize each selection as a normal user-owned profile. Permit any number of named
      profiles per provider with independent argv, environment, path, executable, scope,
      risk acknowledgment, and revisions. Remove the immutable-default duplication detour.
- [ ] Preserve upgrade recovery without repopulating fresh installs: materialize only
      profiles referenced by legacy terminal records, or retain those records in a visible
      exact same-provider rebind flow. Never discard or silently launch a legacy session.
- [ ] Filter the launch menu to configured profiles that the active host probe says are
      launchable. Do not flash unchecked or executable-missing providers while a cold probe
      resolves. Keep unavailable configured profiles in Settings with their current-host
      reason, Refresh, edit, and delete actions; support local/SSH availability skew.
- [ ] Make the Harnesses settings surface use its intended wide responsive dialog and verify
      the complete editor, previews, row actions, and footer at the minimum supported window
      size. Do not solve overflow by shrinking controls or truncating editable values.
- [ ] Replace verbose launch-menu capability prose with `Launch only` and `Integrated`, omit
      redundant provider names, and retain the complete capability/probe explanation in
      Settings and accessible descriptions.
- [ ] Encode Integrated as a strict effective capability: exact session identity correlated
      to host, project, and PTY; exact recovery; provenance/freshness; and a bounded live
      `HarnessSnapshot` containing a meaningful session-state facet plus a trustworthy
      usage/cost/token/context facet. A provider with only launch, probe, exact resume, or
      screen-derived text remains `Launch only` in the compact menu.
- [ ] Re-evaluate Pi, Gemini CLI, GitHub Copilot CLI, and Cursor CLI against current official
      session documentation and pinned installed versions. Implement provider-private
      baseline/discovery/resume/observer logic only where concurrent same-cwd launches,
      relocated config homes, malformed artifacts, SSH, and cleanup all fail closed.
- [ ] Add fixtures and tests for empty first run, batch add, manual add, multiple same-provider
      profiles, legacy materialization, unavailable filtering without UI flash, local/SSH
      skew, compact labels, responsive settings width, and Integrated downgrade when any
      required identity or telemetry facet becomes unavailable.
- [ ] Repeat full verification, production smoke/capacity, and the real local/SSH provider
      matrix. Record exact versions and facet provenance without credentials, transcript
      content, or token-bearing secrets before checking this milestone.

## Acceptance criteria

- [ ] A fresh profile store shows no Shell or harness launch rows. `Add a harness…` offers
      only detected current-host suggestions by default plus an explicit manual path, and
      creates user-owned profiles only for the user's selections.
- [ ] Users can create, name, edit, reorder, and delete multiple profiles for one provider.
      A configured executable missing on the active host is absent from the launch menu but
      remains repairable in Settings, including when local and SSH hosts differ.
- [ ] The settings surface is wide enough to show the full profile editor without the generic
      project-dialog width overriding it, while remaining responsive at the supported minimum
      window size.
- [ ] Compact rows use only `Launch only` or `Integrated`. Integrated always supplies an
      exact project/session association and a fresh, provenance-bearing structured feed with
      meaningful session state and usage/context information suitable for aggregation by the
      future Harness tab; exact resume or provider recognition alone is insufficient.

- [ ] Existing Shell, Claude Code, and Codex menu actions launch the same effective defaults
      after the user selects their templates, and migrated legacy records retain their current
      local/SSH recovery and context behavior. This parity was landed as Milestone 0 before
      profile work began and must survive the opt-in materialization change.
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
- [ ] At least three of Pi, Gemini CLI, GitHub Copilot CLI, and Cursor CLI have verified
      bundled provider templates. Each is labeled Integrated only where a tested installed
      version supplies exact identity/recovery and the minimum structured Harness-tab feed;
      launch-only remains an accepted truthful result. At most one integration investigation
      may be deferred with recorded evidence and re-entry criteria.
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
  environment values. Edits require both expected revisions; stale launch-only edits and
  concurrently deleted profiles fail explicitly, and failed save/delete writes roll memory
  back to the last durable state.
- Fresh launch, exact resume, restart, reconnect, and restore use the same profile contract.
  Same-provider rebind is explicit; cross-provider rebind, ambient latest-session recovery,
  reserved session selectors, stale launch revisions, and unacknowledged elevated or
  unclassified restores fail closed.
- Probe results are keyed by host connection generation, launch revision, project, and
  workspace context, coalesced, and strictly limited to two concurrent probes per host.
  Positive entries expire after ten minutes;
  negative/error entries after two. Menu-open stale refresh and one classified-launch-
  failure refresh are asynchronous and never retry a harness launch.
- The New terminal menu and focused Settings editor are catalog/profile driven. Structured
  argv, literal/reference/unset environment operations, host-qualified path selection,
  risk/capability state, and fresh/resume previews all flow through typed IPC. The production
  smoke launches a project-scoped Custom profile through the real preload, IPC, profile
  store, risk-acknowledgment operation, composer, and PTY supervisor before verifying output
  and teardown. A non-standard profile acknowledgment is persisted per launch revision and
  reused by later menu launches/recovery until launch identity changes.
- Claude and Codex discovery/telemetry receive only provider-declared artifact identity.
  Bundled observer providers cannot register a reserved environment key without declaring
  its artifact semantics. The v1 `HarnessSnapshot` envelope carries provenance, freshness,
  normalized optional facets, and bounded provider data while preserving the existing
  context-pressure UI.

### Initial provider verification — 2026-07-17

Version/help checks were read-only and did not start a harness prompt or create credentials,
transcripts, sessions, or artifacts.

| Provider | Evidence checked | Shipped effective behavior | Re-entry criterion |
|---|---|---|---|
| Claude Code | Local `claude` 2.1.212 plus the retained parity fixtures | Preassigned exact UUID resume and bounded transcript telemetry | Fail closed if its required session surface changes |
| Codex | Local `codex-cli` 0.144.4 plus the retained parity fixtures | Bounded exact rollout discovery/resume and rollout telemetry | Fail closed if exact discovery or resume becomes ambiguous |
| Pi | Current [Pi coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md); executable absent locally | `pi` launch/probe only. The documented session selector identifies an existing session path/ID and does not prove caller-preassigned creation | Add exact recovery only after a version proves caller-supplied new identity or exposes a bounded exact artifact source |
| Gemini CLI | Local `gemini` 0.25.2 help and current [Gemini CLI session documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) | `gemini` launch/probe only. The installed resume surface was not yet verified against one exact newly created session, so hvir rejects it for recovery | Require a full exact ID plus a bounded, project-qualified listing or artifact source |
| GitHub Copilot CLI | Local `copilot` 0.0.394 help and current [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) | `copilot` launch/probe only. Help-text flag presence never upgrades recovery because it does not prove create/resume semantics | Verify create and exact resume against a real installed release, then gate the reviewed behavior on an explicit version threshold and fixtures |
| Cursor CLI | Current [Cursor CLI documentation](https://cursor.com/docs/cli/using); `cursor-agent` absent locally | `cursor-agent` launch/probe only while beta session surfaces lack a proven fresh-session identity | Require exact bounded machine-readable identity/listing and exact resume semantics |
| Custom | Internal structured-command contract | User-selected executable/argv/env/path launch through the PTY supervisor; always Unclassified, with no recovery or structured telemetry | Adopt as a bundled provider only after a reviewed provider contract exists |

All four candidates currently ship as truthful bundled defaults; none was deferred in the
initial implementation. Pi, Gemini, Copilot, and Cursor deliberately remain launch-only.
Launch-only providers declare no speculative recovery or artifact-environment semantics.
Milestone 9 replaces automatic default materialization with opt-in provider templates and
reopens their integration evidence under the stricter Harness-tab definition.

### Acceptance research update — 2026-07-17

The following official documentation was reviewed after the first local UX acceptance pass.
It establishes promising current surfaces, not an automatic capability upgrade: every
provider still needs a pinned installed version, exact fresh-session discovery fixtures,
concurrent-launch tests, artifact-relocation handling, and real local/SSH evidence before
its effective capabilities or compact label change.

- [Pi's current coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
  documents auto-saved project-organized JSONL sessions, `/session` identity, exact
  `--session <path|id>` reopening, configurable session roots, and an inspectable session
  format. This is a strong candidate for bounded fresh-artifact discovery, exact recovery,
  and session/usage observation.
- [Gemini CLI session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
  documents project-qualified auto-saved sessions containing complete conversation, tool,
  token-usage, and reasoning-summary data, plus full-UUID `--resume` and
  `--list-sessions`. This is a strong candidate for exact discovery/recovery and the
  Integrated telemetry minimum.
- [GitHub Copilot CLI session guidance](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
  documents exact `copilot --resume <session-id>`, while the
  [configuration-directory reference](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
  documents per-session `events.jsonl` and workspace artifacts under
  `session-state/<id>`. Exact recovery looks feasible; the event schema and trustworthy
  usage/context facets still require version-pinned validation.
- [Cursor CLI documentation](https://cursor.com/docs/cli/using) documents exact
  `--resume <thread-id>` and session listing. It does not yet provide enough documented
  artifact/telemetry semantics to claim Integrated without a separate installed-version
  investigation.

These surfaces do not relax the fail-closed rule. In particular, exact resume without the
required structured session and usage/context feed may be disclosed in Settings but remains
`Launch only` in the deliberately binary compact menu.

### Automated verification

- `npm run verify`: seam enforcement, lint, both TypeScript builds, launcher help, and 358
  tests across 49 files passed.
- Focused profile/provider/probe/recovery/telemetry verification: 45 tests across six files
  passed after the review follow-ups.
- `npm run smoke`: the production Electron smoke passed, including migrated Claude/Codex
  defaults, structured Custom args/env/path preview, real PTY output, and cleanup.
- `npm run smoke:capacity`: the post-review run passed with 12 live/restored terminals, 75
  measured interactions, 18.6 ms p99 / 18.7 ms maximum frame gap, and +81 MiB net / +126 MiB
  peak memory growth.
- `npm run gauntlet`: repeated verify, production smoke, and capacity successfully; the
  repeated capacity pass measured 18.7 ms p99/max with no positive memory-growth peak.
- Local and SSH transport tests cover structured quoting, explicit environment unset/set,
  bounded host execution, recovery identity, telemetry multiplexing, and PTY failure
  classification without requiring live credentials.

- Copilot review follow-up commit `b164137` centralized local inherited-unset/explicit-set
  precedence across buffered exec, streaming exec, and PTY spawn, and made long synthetic
  legacy profile IDs collision-resistant and always valid. Its focused two-file regression
  run passed 35 tests, the full 358-test verification passed, and the pre-push production
  smoke returned `HVIR_SMOKE_OK`.

The original acceptance-only items remain open: the isolated Milestone 0 real local/SSH
Claude/Codex restore soak, the shipped-provider real-host matrix, the three user-example
local/SSH launches, and the final status transition. The first local UX pass additionally
opened Milestone 9 for opt-in profile materialization, host-filtered menus, responsive
settings, compact truthful labels, and the stronger Harness-tab integration contract. Keep
those implementation commits local until the user completes the expanded acceptance pass;
until its evidence is recorded, Phase 9 remains `acceptance refinement` rather than `done`.
