# ADR-012: Harness providers and launch profiles, not an extension host

## Context

Harness CLIs evolve independently across hosts. Launch, exact recovery, title handling,
context data, cost, approvals, and loaded capabilities do not advance as one boolean
feature. Hard-coded provider unions and renderer labels make each new harness or launch
flag cross-cutting, while arbitrary plugin code would create the extension platform hvir
explicitly does not want.

## Decision

### Trusted provider registry

Evolve the harness adapter into a main-owned registry of trusted, bundled providers. A
provider owns executable conventions, launch and exact-resume composition, session
identity strategy, title normalization, bounded runtime probes, launch-risk rules,
artifact identity, and optional structured observers. All interactive processes still
flow through the PTY supervisor and `ProjectHost`; `TerminalPane` remains provider-blind.

The renderer receives a serializable catalog and treats provider IDs as opaque bounded
strings. Capability vocabulary describes launch, session identity, exact resume, title,
telemetry facets, and host/version compatibility. Bounded asynchronous probes are cached
per host, provider, profile, and launch revision with shorter freshness for unavailable or
failed results. Probe latency affects menu freshness, never first paint or ordinary shell
availability. Missing providers leave persisted records visible but unavailable.

### Profiles and composition

Launch profiles are data-only user configuration layered over providers. Bare Shell is the
one immutable computed built-in and the default for empty workspaces and splits. Bundled
provider templates are offered for explicit adoption rather than silently materialized.
Profiles may be global or project-scoped and carry a stable ID plus a monotonic launch
revision over provider contract, scope, executable, argv, environment/path bindings, and
derived risk. Cosmetic name, description, and order have independent revision semantics and
do not invalidate recovery.

Main owns persistence, optimistic revision checks, validation, composition, and value-aware
preview. Arguments remain arrays and environment changes remain structured
set/reference/unset operations. The provider owns exact-session argument placement and
protected terminal environment values win. The editor's shell-shaped notation performs
only quoting and grouping; it has no expansion, substitution, comment, pipe, operator, or
execution semantics.

Path placeholders come from a fixed vocabulary and resolve to `HostPath` values. A binding
outside a registered project requires an explicit main-owned folder selection on that host
and grants only the composed harness process access, not renderer filesystem authority.
Profiles requiring absent project/workspace context remain unavailable rather than
substituting empty paths.

A bundled custom-command provider can launch explicit executable, argv, and non-secret
environment configuration through the same supervisor/host path. It advertises no exact
recovery or structured telemetry until a trusted provider implements those semantics.

### Secrets, recovery, and risk

Literal environment values are visibly plaintext non-secrets. Secrets are reference-only
and never copied into renderer storage, previews, logs, or recovery records. Remote
forwarding is explicit because local and target-host environments are different authority.

Recovery records bind provider ID, profile ID, launch revision, exact session identity,
host-qualified root, and cwd. Fresh launch, resume, reconnect, and restart use the same
launch revision. Missing or changed launch identity blocks restoration and asks for review;
cosmetic edits do not. Rebinding is restricted to the same provider. Providers may perform
bounded artifact-qualified resume validation: exactly one verified artifact resumes,
ambiguity or unreadable state fails closed, and a definitely absent/empty artifact starts
fresh in the same terminal slot.

Providers classify resolved launch identity as standard, elevated, or unclassified.
Classification is a warning, not a security boundary. Elevated and unclassified profiles
may auto-restore only after explicit acknowledgment tied to the launch revision. Artifact
identity is derived from provider-declared executable, environment/config keys, and path
bindings; a provider cannot observe a reserved key without declaring its artifact meaning.
Unknown artifact semantics fail profile validation.

### Structured observation and extension boundary

Harness data uses optional provenance-bearing facets with version, observation time,
source, freshness, and optional session, model, context, usage/cost, turn/approval, and
loaded-capability data. Unsupported, unavailable, and stale are distinct. Generic terminal
attention remains based on input, output, idle, bell, title, and exit—not provider facets.
Observers remain provider-owned, off-renderer, and multiplexed per `(host, provider)`.

The registry is plugin-shaped internally but is not a public plugin system. New first-class
providers are reviewed and bundled. There is no arbitrary JavaScript/native loading,
provider-contributed renderer UI, marketplace, install lifecycle, remote helper, or ACP/RPC
replacement for the user's native terminal harness. A public declarative or out-of-process
provider SDK requires a separate decision.

## Consequences

New CLIs and one-off commands can launch without weakening deterministic recovery, while
trusted providers add truthful capabilities independently per host and version. Profile
changes that affect authority or recovery are explicit; cosmetic changes remain cheap.
Main owns the sensitive boundaries, and provider churn does not leak into terminal, IPC,
renderer persistence, or shared telemetry policy.

## Rejected alternatives

- A closed built-in adapter union duplicated across main, IPC, renderer, and persistence.
- Opaque shell commands, shell evaluation, or blindly appending user arguments.
- Ambient latest-session recovery or TUI screen parsing.
- Treating all provider capabilities as one boolean or one lowest-common-denominator object.
- Storing secret literals while implying redaction provides encryption.
- Loading third-party code in main/renderer or turning hvir into an extension marketplace.
- Replacing native terminal harnesses with an agent-protocol frontend.
