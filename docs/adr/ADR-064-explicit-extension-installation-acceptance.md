# ADR-064: Explicit extension installation accepts its validated revision

> Lifecycle: Active
> Supersedes: [ADR-049](ADR-049-extension-package-lifecycle.md) | partial | Separate Enable after explicit user-selected installation, including reinstall only.
> Supersedes: [ADR-054](ADR-054-isolated-extension-package-and-capability-boundary.md) | partial | Separate Enable for explicit user-selected installation only; passive discovery and all other revision actions remain unchanged.

## Context

A user who selects a ready-to-run extension through Add extension has already expressed
installation and activation intent. Requiring a second Enable action duplicates that decision
and delays first use. Package revision acceptance remains distinct from permission approval.

## Decision

Successful explicit native Add selection accepts and enables only the exact validated imported
revision. Directory and ZIP installation use the existing serialized package/activation writer
and the same revision-admission body as ordinary Enable. The immutable serving boundary,
bounded source capture, source recheck, no-replace publication, conflicts, retention and durable
installation identity remain unchanged. Explicit reinstall may reuse retained identity and
unchanged approved bindings under the existing admission rules.

Installation grants no native executable approval, file-root access, agent access, Skillager
content approval or mutation authority. Independent viewing can start without optional setup.
Settings retains Enable for passively discovered and deliberately disabled packages, and the
ordinary Disable, Reload, Replace and Remove controls. Passive discovery never activates an
externally copied, replaced or reappearing package.

The Add intent retains renderer and writer authority through acceptance. Cancellation, rejected
validation, conflict or revocation cannot accept another discovered revision or admit late
activation. A physical copy already dispatched may complete; report its outcome truthfully and
leave a later ordinary discovery nonactivating. Native selection stays outside the serialized
writer queue so an open dialog cannot block revocation or Disable. No second activation owner,
store or transaction framework is introduced.

All unaffected ADR-049 and ADR-054 package, isolation, permission, source, revocation and
write-ownership rules remain authoritative.

## Consequences

An installed package is ready for its permitted views without a redundant Enable step. Needed
program and file access still have achievable separate approval paths. A valid package may
remain copied but inactive when its Add intent is revoked or exact revision acceptance fails.

## Rejected alternatives

- A second Enable after successful Add repeats the user's activation intent.
- Activating every newly discovered package would treat passive filesystem changes as consent.
- Renderer activation callbacks or a second writer would duplicate authority and weaken lifetime
  and revision checks.
- Granting executable, file or agent access during installation would conflate package acceptance
  with permission decisions.
