# ADR-075: Session launcher update trust

> Lifecycle: Active
> Supersedes: [ADR-051](ADR-051-approved-finite-connector-execution.md) | partial | Mandatory canonical-target reapproval only for an explicit session-bound decision to trust updates at one exact launcher.

## Context

Versioned symlink targets change during tool upgrades and development rebuilds. The default
canonical-path approval correctly refuses a changed target, but a saved approval alone cannot
truthfully describe current readiness. A development loop also needs an explicit, bounded way
to accept future targets of one launcher without creating durable update trust.

## Decision

The native approval owner keeps canonical-path approval as the default. Contextual status
inspection uses only metadata on already connected `ProjectHost` instances. A proven mismatch
reports `executable-changed`; unknown metadata remains unavailable. Trusted Settings shows the
saved and current targets and repairs the exact selected host, launcher and configuration through
fresh consent. Guests receive bounded reason and host information, without private configuration.
Inspection has finite physical admission; revoked or expired requests retain their slots until
underlying metadata work settles. Passive inspection and active target selection have separate
admission so status cannot exhaust active selection capacity. There is no polling, executable
probe or implicit connection.

An ordinary human may explicitly choose “Trust updates at this launcher until hvir quits.” The
native approval owner holds this choice only in memory. It binds installation, connector, complete
declaration, host, exact selected absolute launcher and complete configuration. For SSH it also
binds the existing host object and connection generation. The decision shows that exact binding
and the current target and explains that future targets may use the host account's authority.
Neither package metadata, a development link nor an agent request supplies this decision.

For an existing unchanged binding, session consent leaves its persisted canonical baseline
unchanged. Ordinary Review update separately replaces that baseline. First-time approval still
establishes a canonical baseline through the existing writer. Each invocation resolves and
validates the launcher afresh and pins the resulting canonical executable; shared refresh identity
includes that target. Terminal handoff uses the same policy, pins the displayed command and
refuses a second target change through consent. Neither path dispatches the mutable launcher.

The same installation's explicit Reload preserves session trust only for unchanged declarations,
hosts, launchers and configuration. Old activation work is always revoked. Disable, Remove,
Forget, changed binding, writer loss, explicit Off, application exit and SSH generation loss end
session trust. A failed Reload before replacement leaves the accepted activation and its choice
intact; failure after replacement revokes any preserved choice. Reconnect or restart cannot
restore it. Off revokes pending and running dependent work and output receipts, then returns
to the saved canonical baseline. Completed effects and handed-off user terminals retain their truthful lifetimes.

This scoped exception changes no source, agent or file grant; introduces no new permission store,
remote generation registry or execution owner; and changes none of the finite execution,
caller/context, capacity or output limits. In-place changes at the same canonical path retain
ADR-051's accepted behavior. Executable content is never hashed.

## Consequences

Normal upgrades become actionable, while a deliberate development choice covers one launcher
for a bounded lifetime. Turning it off can expose a changed target that still needs ordinary
reapproval. Native execution remains host-account authority without rollback or confinement.

## Rejected alternatives

- Silent reapproval of observed targets or rewriting the durable baseline during status checks.
- Durable or global development trust, or permission inferred from package/source metadata.
- Executable-content hashes, new watchers, probes, authentication or a second host lifecycle.
- Retargeting an already displayed terminal decision after consent.
