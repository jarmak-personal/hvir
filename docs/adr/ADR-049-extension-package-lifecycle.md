# ADR-049: Extension package lifecycle and bounded retention

> Lifecycle: Active

## Context

Explicit revision acceptance needs the same validation and immutable serving boundary for
ordinary directories, distributed ZIPs, and author development links. Package replacement and
removal must preserve installation identity and user domain data without introducing another
activation authority or a general transaction framework.

## Decision

Package management captures every source into the existing content-addressed store. ZIPs have
the manifest at archive root; wrapping folders are not guessed or stripped. Lazy asynchronous
archive decoding produces bounded in-memory assets before the existing manifest validator and
atomic staged publication. It checks asset sizes and CRCs, names and destination collisions,
entry types, and explicit directory conflicts. No package scripts run. Compressed input is at
most 20 MiB, expanded assets 16 MiB, each asset 2 MiB, entries 256, depth 12, and decoding 10 seconds.
Unsupported compression/encryption and links are refused. Incomplete drops stay rejected until
the user finishes copying and explicitly discovers again.

Settings has one Add extension intent. Main owns a window-attached native selection and detects
the source form. macOS supports mixed file/directory selection; Linux's ordinary file chooser
selects a ZIP or the exact package manifest to identify its parent directory. The renderer
supplies no authoritative path, destination or format. Native selection remains outside the writer
queue under the renderer and writer authority lifetime. Revocation settles the caller promptly
and ignores any later native return; it does not promise to forcibly close the OS dialog. The
existing serialized activation writer
coordinates bounded capture, a source recheck, exclusive staging in its existing package store,
and atomic no-replace publication into the instance's extensions folder. Import preserves ZIP
bytes or copies directory assets; it never creates an implicit development link. Present source
names and package identities, capacity and unresolved removal conflicts refuse admission. An
absent source with retained setup remains eligible for inactive reinstall and explicit Enable.

Successful import immediately discovers the candidate, without accepting its revision, enabling
code or granting access. Renderer and writer authority are rechecked across asynchronous work,
including immediately before physical publication dispatch. Revocation before dispatch prevents
publication; after an irreversible rename it cannot establish that the copy never occurred.
Late completion does not publish a candidate for the revoked intent. A later ordinary discovery
can observe a completed inactive copy. Exact exclusively owned staging is cleaned on settlement;
bounded interrupted import staging is collected by the next serialized writer. Uncertain cleanup
preserves its exact repair location rather than deleting an unexpected entry.

Discovery treats directory and ZIP candidates equally. Duplicate manifest IDs are all refused;
there is no filename, version, source-kind, or discovery-order preference. A top-level
symbolic link is resolved once per capture to an ordinary canonical directory. Interior links
remain prohibited. Source capture binds to the exact opened source identity and verifies the
selected top-level entry afterward. Settings identifies development packages and missing targets.

The serialized activation writer persists one durable installation identity per manifest ID.
Explicit Enable, Reload, or Replace accepts the candidate revision, retaining that identity even
when its path or source kind changes. Reload and Replace prepare and validate first, then revoke
the old activation before admitting the next. Failed preparation preserves a valid current
activation. Discovery of changed or reappearing sources does not activate them. The present
contract admits no requested access or connectors; revision acceptance grants no broader access.
Later declared trust bindings must be compared by their owning admission policy, not by treating
package hashes as executable trust. Pre-release schemas update directly without old readers.

Retention runs only beneath the same state-write lease and serialized operation lifetime. Keep
at most three revisions per package, 96 revisions and 128 MiB globally, including a prepared
candidate. Exact accepted, active and in-flight revisions are protected. If protected storage
prevents admission, refuse the candidate with an achievable state-removal instruction. Revoke
write authority before cleanup on ownership loss; queued cleanup cannot become a second writer.
Interrupted temporary captures are collected under the next writer after bounded no-follow
inspection. Unexpected or changed stored trees fail visibly instead of widening cleanup.

Remove revokes activation before cleanup. Stage the selected top-level entry under a unique
visible removal name (preserving the ZIP suffix) with no-replace rename, verify its exact identity,
and only then trash an ordinary directory/ZIP or unlink a development link. Check recoverable
trash availability before staging ordinary packages. An identity mismatch refuses deletion;
failed trash attempts exact-identity, no-replace restoration. If restoration cannot finish,
retain the visible staged entry and report its exact location without replacing a foreign source. Author targets are never removed. Persist the narrow removal
intent before staging so an interrupted cleanup remains visible and retryable. The user can keep
installation identity for reinstall or explicitly forget its platform package state. This never
removes libraries, project skills, issue databases or other domain data. Later managed-delivery
records remain separately owned; unresolved remote evidence must outlive installation removal.

## Consequences

One package contract and one activation owner cover all source forms. Bounded refusal and
visible cleanup errors are preferable to partial executable packages or unbounded retention.
Explicit identity retention makes reinstall predictable while discovery remains nonexecuting.
Removal requires a recoverable OS trash capability for ordinary packages. The fixed entry and
byte limits may refuse large packages and retained installations.

## Rejected alternatives

- Extracting archives directly into user-selected paths risks traversal and partial installations.
- Selecting the highest package version or preferring directories silently resolves duplicate trust.
- Following nested links or recursively deleting development targets removes author-owned files.
- Automatic activation of changed sources bypasses explicit revision acceptance.
- Global transactions, autonomous retention timers, migrations or a second writer broaden authority.
