# ADR-049: Project skill explorer and explicit curation

> Lifecycle: Partially superseded
> Superseded by: [ADR-051](ADR-051-quiet-skills-and-bounded-direct-add.md) | partial | Explorer and action presentation, and second confirmation only for exact accepted-source create-only Add; preservation, router and existing-copy review authority remain unchanged.
> Superseded by: [ADR-050](ADR-050-explicit-skill-reading-and-search-defaults.md) | partial | Selected skill reading presentation, exposure action wording, logical-identity grouping and installed-skill search controls, and Search Preferred agent independence from browse trees and action agents only; explorer disclosure, preservation and exposure authority remain unchanged.
> Supersedes: [ADR-030](ADR-030-bounded-project-file-operations.md) | partial | No-replacement rule only for explicitly confirmed preserved native-original adoption/removal through the named Skillager operation; ordinary Files operations remain unchanged.
> Supersedes: [ADR-046](ADR-046-explicit-skillager-library-and-exposure-authority.md) | partial | Skills explorer presentation, derived reusable library acceptance after explicit source approval or backfill, and named local native/router exposure operations only.
> Supersedes: [ADR-047](ADR-047-explicit-skillager-library-initialization.md) | partial | Empty-library presentation adds explicit approved-source backfill; initialization, Git choice and first-skill authoring remain unchanged.
> Supersedes: [ADR-048](ADR-048-explicit-skillager-project-setup.md) | partial | Compact project/library explorer, successful setup presentation, approved-source sync after setup, and explicit native exposure actions only; terminal handoff and ownership remain unchanged.

## Context

Skills are useful in the context of a project: the user needs to see what it uses, find reusable
instructions, and change the selected project's setup. Mutually exclusive scope views and large
metadata cards obscure that relationship. A personal library that remains empty after explicit
source approval also fails to preserve that work for reuse.

Source approval, canonical preservation and project exposure have different effects. Reusable
acceptance must retain the real original decision, while changing or removing an original must
account for everything at that target. A filtered approval snapshot alone does not prove that
extra files, excluded entries or permissions are disposable.

## Decision

### Compact project explorer

Skills remains a peer of Files and Git in the existing left sidebar. Show **In this project**
first and **Your library** as a readily accessible, independently collapsible section in every
project tab. Constrain scrolling so a long project list cannot bury access to the library. The
active registered project/worktree is the default destination; do not present the CLI's raw
project/global scope model as the primary navigation.

Use the Files visual language: compact single-line rows, disclosure chevrons, indentation,
ellipsized names, concise agent/mode and actionable status, quiet hover, clear keyboard focus and
selection, and a consistent actions trigger. Selecting a row opens descriptions, provenance,
status and actions in the normal main viewer. Expansion shows only supported semantic metadata:
related skill occurrences, concrete agent copies and router membership. Group related entries
only when public Skillager identity or lineage proves the relationship, never by equal names or
paths. Do not invent a filesystem tree, scanner or manifest API for this presentation. Expansion
and refresh do not read instruction bodies; body/diff access still requires explicit review of
the selected source version. Selection changes revoke the preceding content review.

All agents is the browsing default. Retain exact agent-qualified occurrence and exposure identity;
a browsing preference cannot silently retarget an action or discard an independently open detail.
Search starts collapsed with query and explicit submit in the first level. Advanced contains scope,
**Preferred agent**, and coverage. Local search defaults to skills available to the current
project, including the library. All agents submits one query omitting the CLI agent argument. A
selected agent supplies the CLI's native-variant preference and compatibility context, not an
invented strict compatibility filter. A strict filter requires the separate supported CLI contract.
Keep one returned ranking/window: never merge limited queries or post-filter that window into a
false completeness claim. Show the submitted query, actual source and known membership separately
from an unsubmitted draft. No-match is not empty inventory.

Hide the successful setup card. Keep setup reachable through a compact explicit control and
retain actionable running, review-needed, unavailable and failure states. The existing terminal
handoff, source review, library initialization, disabled Settings-toggle-only behavior and
ordinary viewer/session lifetimes remain authoritative. Sidebar/viewer demand is independent:
leaving Skills releases its search; metadata refresh remains while an enabled connected sidebar
or feature viewer is foreground-visible. Disable, workspace close and renderer replacement revoke
all feature demand and reject late publication. Disclosure changes do not create execution grants.

### Exact approved copies become reusable library content

After an explicit successful source approval/setup operation, Skillager automatically preserves
currently approved external sources of every type in its effective inventory: project/native,
environment, package, collection and global. Owned library entries are not recursively imported.
The exact verified copy gains canonical acceptance for reuse across projects, **including when
the original decision was project-only**. This intentionally broadens availability of the derived
copy; it does not rewrite the original decision's scope.

Skillager records a stable logical source identity, distinct physical origin occurrences, the
actual source decision/evidence identity, scope, content hash and actual override evidence,
plus the resulting library identity, accepted hash and derivation lineage. Preserve pin semantics.
Derive acceptance only for verified identical bytes through the existing approval/audit owner.
Never fabricate an override reason or approve changed, blocked, pending, stale or ambiguous
content. Editable provenance, equal hashes or Git history alone are not derivation authority.
Current origin observation remains distinct from historical acceptance evidence.

Sync leaves original sources in place and never exposes, adopts, removes or converts them.
Subsequent approved versions may advance an unchanged prior synced library copy; preserve
customized, independently changed, pinned, blocked or conflicting canonical entries and report the
conflict. Source approval can succeed while sync fails; neither roll back that approval by
assumption nor claim successful canonical preservation from a copied-but-unaccepted tree.

Offer explicit **Sync approved skills** backfill directly in an actually empty Your library and
through a compact library menu once populated. Use a named public CLI operation in the selected
authorized local context, with read-only public status for reconciliation. Hvir supplies its
retained connected library UUID and canonical local root as paired expected-identity arguments.
The CLI checks that exact registration before work and again under mutation authority; a removed,
replaced or mismatched library refuses. Bound hvir sync/status never initializes another library,
falls back to a default, or silently changes the connection. Only independently invoked standalone
CLI approval/setup retains its own first-use initialization authority. An SSH project supplies
no local cwd or discovery fallback: only the independently authorized local personal-source
context is available there. Browsing, expansion, connection, search and refresh remain read-only
apart from existing CLI cache maintenance.

Resolve discovery and the identity map once per bounded operation, stage finite chunks, reuse
library locks, verified copying, Git and approval/history owners, and refresh once after controlled
completion. Do not run a full-catalog importer for each row. Preserve the existing finite process,
output, concurrency and request-lifetime limits; bounded partial completion is preferable to
truncated success. Report complete admitted per-item created, updated, unchanged, conflict,
skipped, failed and uncertain outcomes. After lost or malformed completion, observe actual public
state before another explicit write; never infer rollback, automatically retry or approve repair.

### Explicit project exposure lifecycle

The same applicable actions appear in row menus, keyboard-accessible triggers and viewer actions:
**Add to this project**, **Full skill**, **Stub**, **Group in router**, **Edit members**,
**Ungroup**, **Update**, and **Remove from this project**. Avoid ambiguous Promote/Demote commands.
A library-only entry offers Add. A concrete copy supplies its agent; otherwise request one exact
agent. Preview the active registered destination and every effect before confirmation. Reuse
existing managed Add, Update and Remove owners. Their eligibility is independent of the original
source's later approval, drift or sync conflict: Add/Update require the selected canonical version's
own acceptance, while managed Remove requires the selected target's removal protections. Pending
canonical customization cannot inherit the original approval; an accepted canonical customization
remains reusable even when automatic sync must preserve its conflict. Show the selected library or
project copy's own approval/version first and keep the original decision in lineage. Removal preserves canonical library content,
other projects and unselected agent copies; canonical-library deletion is outside this decision.

Native Full/Stub adoption and approved native removal require a named public token-bound operation.
Select the exact origin occurrence and validated source-to-library relation. Revalidate current
approval, canonical accepted bytes, provenance binding, target identity, all original entries and
modes. Every byte/mode being discarded must be preserved or independently covered by the explicit
removal contract. Refuse extra/excluded, symbolic or special material that the preservation proof
does not cover. Never chain an unbound adopt-then-remove sequence, force overwrite, or borrow
ordinary Files replacement authority.

An unwanted pending, blocked or unpreserved original need not be approved for removal. Offer
**Remove in Files…** to reveal its exact current-project host-qualified folder through the existing
Files navigation owner. The user then invokes the existing separate Move to Trash/Delete
confirmation with that host's actual recovery guarantees. The handoff itself neither deletes nor
approves, and is not a Skillager content-token confirmation. Existing Files confinement, dirty
buffer checks, confirmation and cancellation remain in their owner; unrelated viewer and terminal
state remain intact.

Named routers reuse public project tags and agent-qualified router identities. Offer an editable
**New router** name or selection of an existing public named group. The CLI returns the normalized
tag and actual target; a name conflict requires a new preview, with no silent suffix or takeover.
Preview creates no tag, projection or project mutation. Show the complete desired membership and
the exact standalone copies selected for replacement; omitted copies remain. Existing-group edits
use the returned router identity, not a fresh group request with the same name.

Every departing member explicitly becomes Full, Stub, or **Remove from project**. Removal creates
no standalone copy and does not require approving the departing body; remaining or restored
sources retain their acceptance requirements. Whole-group Ungroup selects Full/Stub for members
and removes that router. Router-only removal remains a separate existing operation. Ungroup and
router removal retain the tag's curated members; deleting an unused tag is outside this scope.
Refuse membership edits to a tag shared with another agent/router unless the bounded contract
explicitly accounts for those effects. Legacy explicit-set router identities cannot silently
become mutable named groups.

Use the existing exposure domain's bounded plan, locks, staging, materialization, tag and removal
owners. One confirmation binds the exact request, project, agent, library, accepted source/lineage
versions, router/tag membership and complete target/effect payload, including absent targets,
retained entries and modes. Revalidate before mutation and before disposing detached originals.
Preserve detached originals until verified completion; safe rollback never overwrites concurrent
changes. Partial failure reports exact observed dispositions and required recovery. Lost/malformed
output remains uncertain until public observation; no success from exit code alone, automatic
retry, generic transaction framework or promise of cross-directory atomicity.

### Existing authority and transport boundaries

Skillager remains user-installed and owns discovery, local trust and mutation contracts. hvir
consumes bounded public metadata through its existing feature owner, typed ports and ProjectHost,
with heavy work off paint. Root components wire lifetimes rather than absorb curation policy.
Skill metadata nodes do not acquire DirectoryTree filesystem authority.

New native/router operations are local only. Existing SSH Full export/delivery remains unchanged:
Skillager owns local approval and transport-neutral export; hvir owns SSH observation, records,
transfer, safe destination publication/removal and recovery. No remote catalog, CLI, Stub, router
or Working fallback is introduced. Installation management, authoring IDE, history restore,
automatic exposure and network library synchronization remain excluded.

## Consequences

Users can inspect and curate a project's skill setup while the reusable library stays close at
hand. Explicit approval now preserves reusable content with auditable derivation, so changing a
project need not discard the reviewed source. Original approval scope remains inspectable.

The CLI must provide source lineage and complete bounded native/router plans before those actions
are available. Compact presentation does not weaken exact source/target checks or imply coverage
that public metadata cannot establish. Pending removal stays possible through the existing Files
flow without turning unwanted content into trusted reusable instructions.

## Rejected alternatives

- Large metadata cards and mutually exclusive library/project views obscure the project lifecycle.
- Grouping by display name or scanning file trees invents relationships and duplicates discovery.
- Per-row imports, writes on browse, or fabricated global overrides lose explicit authority and
  cannot scale within bounded work.
- Mandatory approval before deleting unwanted content confuses trust with file ownership.
- Hidden tag/expose/remove chains and unrestricted force paths cannot bind complete effects or
  preserve concurrent edits; a generic transaction service adds authority beyond this domain.
