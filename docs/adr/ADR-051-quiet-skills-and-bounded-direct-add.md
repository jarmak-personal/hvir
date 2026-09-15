# ADR-051: Quiet Skills presentation and bounded direct Add

> Lifecycle: Active
> Supersedes: [ADR-046](ADR-046-explicit-skillager-library-and-exposure-authority.md) | partial | Skills presentation, retained-observation freshness, and second confirmation only for exact accepted-source create-only Add; identity, token, approval and other mutation authority remain unchanged.
> Supersedes: [ADR-049](ADR-049-project-skill-explorer-and-curation.md) | partial | Explorer and action presentation, and second confirmation only for exact accepted-source create-only Add; preservation, router and existing-copy review authority remain unchanged.
> Supersedes: [ADR-050](ADR-050-explicit-skill-reading-and-search-defaults.md) | partial | Reader and action presentation, and exact accepted-source create-only Add interaction only; explicit current-file reading, review authority and search defaults remain unchanged.

## Context

Repeated checking messages and metadata obscure a small skill explorer and interrupt reading.
The viewer should use its available space, show what can be done with the selected occurrence,
and retain useful observations without turning them into fresh authority. A second confirmation
adds little to an explicit Add of already accepted instructions when its only permitted effect
is creation at the displayed absent destination. Replacements and approval establish different
facts and still need their existing review.

## Decision

### Compact explorer and quiet observations

Use shared subtle header bands for Search, In this project and Your library, with consistent
disclosures, compact rows, selection and keyboard focus. Bound inventory scrolling so a large
project cannot bury the library. Search starts collapsed; its expanded input retains an accessible
name without a redundant visible label. Keep explicit submission, Advanced options, submitted-query
truth, all-agent browsing, grouped identity and hide-installed defaults, and truthful unsupported
or unknown-presence behavior from ADR050.

Use an instruction-card SVG for a skill. Compact agent and original/copy glyphs have tooltips
and accessible names; selected details state their meaning in words. A library section supplies
its rows' residence. Changed, Update available, Needs review and failure exceptions remain legible
text, not color or unfamiliar icons alone. Reuse existing controls without external icon packages.

Keep the existing bounded visible-demand refresh cadence and explicit invalidations. Initial
loading, background refresh and failed refresh remain distinct. Retain the last successful bounded
observations while refreshing or after a transient error. Activity belongs in the existing fixed
header control; it must not replace row labels or change list height, count, scroll, selection or
successful-setup disclosure. Retained observations carry their last successful check and a compact
stale/error notice with explicit retry when needed. A failed check does not mean an empty inventory
or an uninitialized project. Retention does not grant fresh action authority.

Preserve context/generation revocation, process/output limits, explicit body lifetimes and the
separate library/project observation owners. No additional polling, cache framework, scanner or
implicit instruction reread is introduced. Metadata changes never relabel previously opened bytes
as a new accepted version.

### Reader, visible actions and settings

The detail container and controls fill the viewer; constrain rendered prose line length rather
than the whole page. Source and diffs use the available width. A compact title, description,
source breadcrumb and relative path lead the page; Details & provenance retains the full
host-qualified location and exact source information. Instructions has one disclosure and the
existing Rendered/Source control pattern. Collapsing hides the whole body and preserves mode and
reading position for that tab. Reuse viewer scrolling instead of a nested fixed-height source box.

Place applicable actions beneath the title. A library selection shows concrete agent/mode and
Add to project; a project copy shows applicable mode change, grouping, Update and secondary Remove;
a router shows membership actions. Originals retain preservation-backed choices or Remove in Files.
Context menus are shortcuts to the same eligibility and controller owner. Search preference never
chooses an action agent. Unsupported CLI or host operations remain unavailable. Relevant Needs review
actions stay discoverable and separate from ordinary reading.

Preserve ADR050's explicit selected-current-file reading, actual original/Full/Stub/router bytes,
proven canonical navigation, confinement, revocation and separate complete-tree approval review.
Use the existing Settings field grid and aligned checkbox/copy layout. Enabled settings show a
compact connection and collapsed connection/executable details; disabled settings retain only the
Enable Skillager control and its setting label. Existing Save app settings and integration
revocation behavior remain. Installation and updates are user-managed.

### Exact create-only Add

A deliberate Add click may directly create the selected accepted library version at an absent
project destination. Display the registered project/worktree and host, concrete agent, and Full/Stub
mode before that click. The request binds that source identity and accepted content hash/version, destination,
agent, mode and current context. Reuse the existing public preview/token machinery internally,
validate the complete plan as creation only at that exact absent target, then apply the bound plan
through its existing mutation owner. Accepted pinned sources retain their existing eligibility;
this exception does not broaden Update or replacement permissions. No second modal is required
for this bounded operation.

A source changing between click, preparation and apply cannot silently advance to another accepted
version. Occupied or changed targets, pending/unaccepted sources, unmanaged content, missing
prerequisites, unsupported operations and uncertain outcomes stop direct Add with accurate next
steps. An Add cannot become Update, replacement, native adoption, approval, an alternate destination
or a retried uncertain write. Preserve token rechecks under mutation authority and cancellation,
connection, renderer, workspace and host lifetimes. Local Skillager mutations and hvir-owned SSH
ProjectHost delivery keep their existing distinct ownership. SSH still supports Full only.
A prerequisite declaration marked unchecked is not proof that the destination satisfies it.
Keep that limitation visible and require an explicit exception/review when the direct path cannot
establish the displayed intent; do not invent remote prerequisite probing or silently discard
the declaration.

After authoritative success, refresh project presence and name the actual agent/project outcome.
Offer Remove from project through its existing current-target protections; do not promise universal
Undo. Updates, mode changes, router membership, removal, original adoption/preservation and content
approval retain their separate applicable review and confirmation. An explicit Add does not approve
a pending library source or authorize changes to other copies.

Keep remaining reviews task-specific: action and destination summary first, complete affected files
reachable, one useful creation/removal list, and Before/After where both states exist. Put hashes,
modes, full paths and transfer diagnostics under technical details. Collapsing technical presentation
does not omit effects, weaken tokens or hide partial/recovery outcomes. Unknown completion never
becomes verified success merely through refresh, dismissal or reconnect.

## Consequences

The explorer stays stable during ordinary observation, reading uses the available pane, and common
actions are discoverable without opening a menu. Direct Add reduces friction while retaining exact
accepted-version and absent-target authority. That convenience depends on strict create-only
validation and honest refusal; retained observations cannot substitute for it.

The established source, mutation, transport and review owners remain necessary. This changes no
search algorithm, approval policy, authoring boundary, source budget or installation authority.
It adds no general transaction, recovery or undo framework.

## Rejected alternatives

- Replacing rows with checking or error placeholders: causes visual churn and hides useful retained
  observations; failed refresh is not proof of absence.
- Treating retained metadata as current approval or rereading bodies on refresh: confuses observation
  with exact source authority and violates explicit reading lifetimes.
- Making menus the only action entry or duplicating their policy in a new toolbar: impairs discovery
  or allows inconsistent eligibility.
- Unconditionally applying whatever Add preview returns: permits silent source advancement or
  replacement. Only the exact selected accepted version and absent/create-only effect qualify.
- Removing confirmation from every operation or promising Undo: ignores changed targets, source
  approval and multi-target or partial mutation effects.
