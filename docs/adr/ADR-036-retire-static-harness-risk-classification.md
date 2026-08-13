# ADR-036: Retire static harness risk classification

## Context

ADR-012 made providers classify a resolved launch as `standard`, `elevated`, or
`unclassified` and tied acknowledgment of the latter two classifications to the profile launch
revision. That classification describes launch syntax, not the current permission state of the
live harness.

Native harnesses may change their authority after launch. Claude Code exposes an immediate
structured permission-mode artifact after an in-session Shift+Tab change. In the observed Codex
0.147.0 rollout, a `/permissions` change did not immediately materialize a corresponding settings
update. Launch flags such as `--dangerously-skip-permissions` and `--yolo` therefore cannot support
a truthful current-session badge across providers. A launch-derived warning or recovery gate may
remain stale while the terminal is live and creates false confidence rather than useful safety
information.

This mismatch cannot be repaired by extending individual flag classifiers. It requires separating
launch composition from current-session permission observation while preserving the exact
provider, profile, host, artifact, and recovery boundaries already established by ADR-006,
ADR-010, ADR-012, and ADR-014.

## Decision

Launch syntax is not current runtime permission state. Providers and profiles no longer classify
launches as `standard`, `elevated`, or `unclassified`. Static launch risk and its acknowledgment
are not part of provider capabilities, profile launch identity, launch revision, fresh launch,
profile rebinding, or exact-recovery admission.

Removing obsolete risk metadata alone does not change fresh or resume command composition,
increment a launch revision, or create profile drift. Existing provider ID, profile ID, launch
revision, exact session identity, artifact validation, availability, registered-root,
host-qualified path, and disconnected-host rules remain authoritative. Provider-owned launch and
resume composition remains unchanged.

Readers may accept supported profile and terminal records containing obsolete risk and
risk-acknowledgment fields, but those fields have no active meaning and new records omit them. A
retained session previously blocked only by missing risk acknowledgment becomes eligible for the
same ordinary exact-recovery evaluation as another retained session after upgrade; every other
identity, availability, artifact, host, and provider rule still applies. No downgrade compatibility
is promised to an older hvir version that requires the obsolete fields.

A future current-session permission indicator requires provider-owned, authoritative structured
observation qualified to the exact provider session. The observation must carry provenance and
observation time, follow the session and host lifecycle, and distinguish current data from
pending, unavailable, and stale states. A provider that cannot produce that evidence exposes no
permission claim. Terminal output parsing, TUI rendering or scraping, process-command inspection,
stale artifacts, installed remote helpers, and agent-protocol frontends are not permission-state
sources.

This record supersedes only ADR-012's launch-risk rules in the trusted provider registry, the
derived-risk component of profile launch revision, and the risk classification and acknowledgment
policy. ADR-012's registry, structured profiles, composition, secret, host-binding, observation,
and extension-boundary decisions remain in force. ADR-006 continues to govern exact recovery,
ADR-010 continues to govern host qualification and local/SSH behavior, ADR-014 continues to govern
ownership, and ADR-024 continues to make Bare Shell the default explicit launch choice.

## Consequences

hvir no longer shows or enforces a permission claim that can become inaccurate after launch.
Fresh launch, rebinding, and recovery lose a warning gate, but that gate never represented live
authority and was not a security boundary. Exact provider and recovery validation remain
unchanged.

Supported retained records survive the upgrade without artificial profile drift or lost recovery
identity. Older versions may not understand records newly written without risk state, so downgrade
is intentionally unsupported.

An eventual permission indicator is possible without making the renderer provider-aware, but only
after a provider can satisfy the exact-session structured evidence contract. Pending, unavailable,
and stale presentation would be required rather than silently retaining the last observed state.

## Rejected alternatives

- Keep launch-derived risk as a static badge or warning; it can become wrong after an in-session
  permission change and invites false confidence.
- Recognize more launch aliases, including `--yolo`; classifier completeness does not make launch
  syntax current session state.
- Keep acknowledgment only as an automatic-recovery gate; revision-bound acknowledgment still
  gates on a potentially stale classification and adds no exact-recovery evidence.
- Infer permission state from terminal output, TUI rendering, process command lines, or old
  artifacts; these sources are ambiguous, stale, or outside the provider-owned structured seam.
- Install remote helpers or replace native terminal harnesses with an agent-protocol frontend;
  either would widen hvir's authority and extension boundary for a presentation feature.
