# ADR-050: Explicit skill reading and search defaults

> Lifecycle: Partially superseded
> Superseded by: [ADR-051](ADR-051-quiet-skills-and-bounded-direct-add.md) | partial | Reader and action presentation, and exact accepted-source create-only Add interaction only; explicit current-file reading, review authority and search defaults remain unchanged.
> Supersedes: [ADR-046](ADR-046-explicit-skillager-library-and-exposure-authority.md) | partial | Ordinary skill-body activation and confined reading grant, and logical-identity grouping and installed-skill search defaults only; verified review, acceptance and mutation authority remain unchanged.
> Supersedes: [ADR-049](ADR-049-project-skill-explorer-and-curation.md) | partial | Selected skill reading presentation, exposure action wording, logical-identity grouping and installed-skill search controls, and Search Preferred agent independence from browse trees and action agents only; explorer disclosure, preservation and exposure authority remain unchanged.

## Context

A view-first workbench should make a selected skill readable without requiring an approval
workflow. Metadata is useful context, but it should not obscure the instructions. Reading a
current file and approving a complete source tree establish different facts and need distinct
authority. Installed stubs and routers are also real documents; substituting their library
definition would conceal what the project actually uses.

Search is most useful for finding skills to add. Multiple proven occurrences of one logical
skill and already-installed versions can crowd a bounded result window. Grouping by names or
filtering an already-limited response would hide unrelated sources or imply completeness that
the search owner cannot establish.

## Decision

### Explicit activation opens the selected current file

Activating a skill row or its retained detail tab opens that source's current `SKILL.md` in the
existing main viewer. Lead with the readable body. Keep source, current status, provenance and
actions secondary. Focus-only movement, search-result arrival, metadata browse, disclosure and
refresh do not grant body reads. Inactive detail tabs do not prefetch instruction bodies.

Label the actual selection as **Your library**, **Project original**, **Installed Full**,
**Installed Stub** or **Installed Router**, with its host-qualified location. A concrete project
occurrence shows its own current file, including stub/router instructions. A separate action may
open the canonical definition only when public library UUID plus skill identity or validated
lineage proves that relationship; it creates a new explicit selection, never a silent substitution.

An ordinary library read is confined to the exact connected local library identity and root. An
ordinary project read is confined to the actual selected occurrence in the active registered
host-qualified project/worktree. An unproven external search source cannot widen either grant.
Pending or blocked project instructions can be read as ordinary text without approval. Present
their actual status, and never treat text rendering as execution or permission to use the skill.

The body is the selected source's **current file**, not a verified complete tree or a historical
accepted snapshot. If it no longer matches the selected accepted search observation, report the
change instead of labeling new pending bytes as that accepted version. A separately labeled
current-file selection may be offered within the same confinement. Do not retrieve an older Git
body or silently restore history when the canonical working tree is pending.

Reuse the existing feature content lifetimes, bounded read mechanics, ProjectHost and rendered
document protections: finite size, safe HTML/CSP, asset confinement and work off paint. Bind reads
to selected source identity, host-qualified location, workspace, connection, renderer and active
content lifetime. Revocation rejects late completion. Do not add bodies to metadata, a scanner,
body index, generic content service or alternate filesystem owner.

Ordinary reading never prepares a mutation preview, approves, syncs, exposes or updates. Explicit
**Review content** still prepares the complete verified source tree and displays its own retained
bytes; **Accept** still requires the separate exact confirmation. Reading a file cannot satisfy
that review. Preserve all existing approval, pin, stale-source, token and mutation protections.

Use **Use as full skill…** and **Use as stub…** for the existing exposure actions in row menus and
viewer controls. Preserve their action identities, exact agent/source selection, eligibility and
complete effect previews. This wording does not introduce a new conversion or approval path.

### Search defaults to one proven skill that is not installed

Default to one representative per proven logical skill. Use supported public source identity,
canonical library UUID plus skill ID, and validated lineage. Proven versions of the same logical
skill may group despite different bytes. Unknown or conflicting identity relationships remain
distinct; equal names, slugs, paths, hashes or modification times never establish a join.

Prefer the currently readable, accepted canonical library entry when it is eligible. “Latest
accepted” means that current accepted entry, not a historical body behind a pending working tree.
If it is unavailable, another eligible actual occurrence may represent the proven group. Preserve
the returned ranking and identify the occurrence that matched the query, especially when the
preferred canonical representative's own content did not match. Opening or acting on a result
must identify its concrete selected source rather than attribute another occurrence's evidence
to it.

**Include installed** defaults off. Exclude every version of a proven known identity present in
the active project, including older or modified native originals, Full copies, Stub copies and
qualified router members. Presence across **all supported agents** counts. Preferred agent remains
a native-variant/compatibility preference, not a strict filter or a narrowing of installed presence.
Existing project entries and updates remain accessible through **In this project** and Include
installed. Search Preferred agent does not filter either browse tree or retarget an action’s
concrete agent.

Advanced exposes **Include installed** and **Show separate copies**. The latter returns concrete
occurrences instead of one group representative, retaining source, agent, version and target
identity. It does not turn off installed exclusion. Keep submitted controls visible when Search
collapses; editing a draft does not relabel existing results. Project/library browsing remains
independent of search, and no-match never means empty inventory.

Skillager owns identity grouping and installed exclusion **before** its single bounded ranked
window through an opt-in versioned public search contract. Preserve existing cancellation,
process/output bounds, accepted-content validation and large-catalog limits. Hvir does not merge
limited queries, post-filter a returned 50 into a completeness claim, or build another search
engine. Missing or uncertain presence proof stays visible or makes the filter explicitly
unavailable; it never means absent.

Keep local personal-library candidate approval separate from explicitly selected project-presence
observation. Library-only search without that project context must not trigger ambient discovery.
SSH search still runs locally against the personal library. Hvir may supply bounded proven
library-UUID/skill-ID exclusions from its own all-agent remote delivery observation before the
local CLI ranks results. That input is presentation evidence only: no remote cwd, path, discovery,
SSH command or mutation grant enters the local search request.

Detect the supported public contract rather than infer it from a version number. If the installed
CLI cannot provide these semantics, explain their unavailability and offer an explicit legacy
search with installed skills included and its existing agent-variant behavior. Do not silently claim grouping or installed exclusion.
Skillager remains user-installed; no dependency installation or upgrade management is added.

## Consequences

Selected instructions become immediately readable while exact acceptance remains deliberate.
Current-file status and explicit matched-source evidence prevent a convenient representative from
misrepresenting either approval or search relevance. Identity-based defaults reduce duplicate and
already-installed results without hiding unproven sources.

Ordinary reads require their own narrow active lifetime, and complete search defaults depend on
the public pre-limit contract. Unsupported installations and unknown relationships remain visible
limitations. Existing explorer semantics, source preservation, managed removal, local router
authority, SSH transport, disabled behavior and setup/terminal ownership remain unchanged.

## Rejected alternatives

- Requiring approval review just to read instructions: confuses viewing with trust and excludes
  useful pending project content.
- Reading on focus, expansion or refresh: creates implicit body access and inactive work.
- Replacing installed bytes with a library body, or reading historical accepted Git content when
  the current tree is pending: obscures the actual source and requires different version authority.
- Grouping by display names or equal bytes, or filtering limited results in hvir: loses identity
  fidelity and cannot preserve the CLI's complete bounded ranking.
- Hiding every copy unconditionally: prevents exact occurrence inspection; Advanced exposes both
  installed identities and separate copies explicitly.
