# ADR-040: Complete source budgets and dependency policy

> Lifecycle: Active
> Supersedes: [ADR-014](ADR-014-modular-monolith-ownership.md) | partial | Architecture hotspot budgets paragraph: complete source budgets and extended dependency enforcement; authority/seam checks stay blocking.

## Context

ADR-014 makes ownership, dependency direction, and blocking architecture checks part of hvir's
modular-monolith discipline. Baseline-conditioned size checks leave older production files and
contributor tools ungoverned, however, and conflate a useful comfort target with a hard limit.
Expired extraction exceptions cannot explain the current ownership of a retained module. Static
import components also need a distinction between executable cycles and coherent type references.

Governance must precede its consumption. An implementation cannot justify its own enlarged owner
by changing a budget beside the source, including through separate commits in one candidate.
Staged epic delivery must preserve separately accepted policy without making the cumulative PR
appear to authorize itself.

## Decision

### Relationship to ADR-014

This record amends and replaces only ADR-014's paragraph beginning “Architecture hotspot budgets
and authority/seam checks are blocking in normal verification.” It specifies complete source
budgets and extends dependency enforcement. ADR-014's modular-monolith, capability ownership,
inward dependency direction, process boundaries, resource lifetimes, style order, public seams,
and test discipline remain accepted. Authority/seam checks remain blocking in normal verification.
ADR-035 previously amended only the expiry/removal metadata requirement for `terminal-runtime.ts`;
its named 600-line non-growth cap remains accepted. Passing these checks never establishes healthy
ownership.

### Complete maintained-source coverage

The named recursive roots are `src/` (including production, colocated tests, and
`src/main/smoke/`), `test/`, `scripts/`, `packages/`, `build/`, `.github/`, `.githooks/`,
`.agents/`, and `.claude/`. Repository-root source files are included too. TypeScript includes
`.ts`, `.tsx`, `.mts`, `.cts`, and their declaration forms; JavaScript includes `.js`, `.jsx`,
`.mjs`, and `.cjs`; CSS includes `.css`; shell includes `.sh`, `.bash`, and `.zsh`, plus
extensionless shell files identified by a shell shebang, including Git hooks.

Inventory repository-owned files, including added local files for pre-commit verification.
Installed dependencies, Git internals, and disposable build output are not maintained source;
exclusions must name that role explicitly, and must not hide tracked maintained files. Symlinked
skill aliases count their repository-owned target once; an unresolved or escaping source alias
is an inventory error. A recognized source outside the named roots is a coverage error requiring
an explicit root disposition, never an exemption. An additional maintained source language
requires an explicit policy before adoption; changing an extension is not an escape hatch.

Each file resolves to exactly one governing classification: ordinary default, stricter named
budget, exact over-default budget, or generated artifact. Duplicate, conflicting, malformed,
unreadable, or unclassified entries fail verification. Production, tests, smoke, and contributor
tooling are reporting roles, not different default ceilings. Age, baseline membership, an
unchanged diff, and directory or extension omissions never confer immunity.

### Physical lines and blocking ceilings

Count physical lines from file bytes: an empty file has zero lines; otherwise count LF bytes and
add one if the last byte is not LF. Blank and comment lines count. CRLF counts once, and a final
newline does not add an empty line. Git revision blobs and local files use the same rule, with no
formatter, platform, syntax, or generated-header adjustment.

The preferred comfort target is 500 lines. Reports show every maintained file's count, governing
classification, effective ceiling, and whether it exceeds that target. A file with 501–1,000
lines passes the ordinary size rule and remains visibly above comfort. The blocking default
maximum is 1,000 lines in every maintained-source role.

Exact stricter named budgets remain blocking for composition roots, facades, manifests, and
other narrow owners, including `src/main/index.ts`, `App.tsx`, the root stylesheet manifest,
and `GitEngine`. They retain their existing ceilings and non-growth constraint unless separately
accepted policy changes that invariant; a new default never silently replaces them. A stricter
non-growth ceiling is the smaller of its declared maximum and comparison-base count.

### Exact exceptional ownership

An over-default budget names an exact repository-relative file path, integer maximum, capability
or seam owner, cohesion rationale explaining why one owner is preferable to a mechanical split,
and objective reconsideration condition. Wildcards and an unbounded “coherent” category are not
budgets. A renamed or moved path needs authorization for its new exact identity.

- A **transitional** budget also names its removal issue. Its effective ceiling is the smaller
  of the declared maximum and the comparison-base line count. Reductions therefore ratchet down.
  A completed removal issue cannot remain its current disposition: remove the exception or obtain
  a separately accepted replacement with a current owner and condition.
- A **durable coherent** budget names the architectural change that would invalidate its cohesion
  rationale. Its effective ceiling is its exact base-authorized maximum, allowing growth within
  that maximum without a calendar expiry or a shrinking ratchet. Introducing or increasing it
  requires a separately accepted policy-only change that reaffirms both rationale and condition.

Policy-only bootstrap may establish exact budgets for unchanged existing files. It does not
grandfather unspecified files. A missing base file cannot supply a transitional count; new source
uses the default or a separately authorized durable budget. A transition to durable policy is a
relaxation, as is resetting a transitional ratchet, and requires the same separate acceptance.

### Comparison bases and policy provenance

Let `H` be the full candidate head SHA and `B` the exact current target-branch SHA used by its
verification attempt. `B` must be an ancestor of `H`; local uncommitted changes are evaluated on
top of `H` and supply no authorization. Record full immutable SHAs. A stale branch, missing Git
object, ambiguous base, or missing required provenance fails the enforcing check. Refreshing a
target invalidates prior verification and requires a fresh comparison.

| Delivery | Comparison base | Admissible policy |
| --- | --- | --- |
| Ordinary PR to `main` | Current `main` SHA `B` | Policy already accepted into `B`; a proposed policy-only change has the bounded admission below |
| Direct epic-child PR | Current exact native parent's epic branch SHA `B` | Policy already accepted into `B`, including a separately merged policy-only child; no other epic branch is interchangeable |
| Cumulative epic PR to `main` | Current `main` SHA `B`, plus verified accepted epic integrations | Main policy plus the narrowly proven policy-only epic changes described below; final main acceptance remains separate |

An accepting policy-only PR has a complete base-to-head diff restricted to architecture policy,
its checker, dedicated checker tests/fixtures, and the documentation and verification wiring
necessary for that policy. No consuming source, product behavior, general test/smoke scenario,
or unrelated tooling changes are allowed. Every existing file whose new or relaxed budget is
being admitted must be byte-identical to its base version. Changed checker source and fixtures
must themselves pass the prior applicable budget or ordinary default; the checker cannot give
its own growth an exception in the same PR. A new path's durable budget can be reserved before
its source exists, but adding that source waits for a subsequent consuming PR.

Pre-merge verification of this policy-only proposal evaluates the proposed policy against the
whole unchanged consuming inventory, validates its closed metadata and authorization constraints,
and exercises the changed checker through its dedicated fixtures. This permits a bootstrap to
pass before its budgets are accepted. The result is explicitly a policy proposal: it cannot
authorize a consuming candidate until that separate PR is merged through its normal acceptance
path. A PR mixing new authorization and consuming source fails even if the policy commit precedes
the source commit. An existing budget may be tightened in a consuming change; a candidate may
never use an unaccepted relaxation.

For cumulative delivery, an epic policy absent from `main` is admissible only with bounded,
read-only GitHub and Git evidence of the separately accepted policy-only PR. Verify the canonical
repository, exact native epic-child relationship and epic target, merged state, recorded base,
head and merge SHAs, full policy-only diff, and the coherent successful CI attempt for that head
under ADR-037/038. The recorded base must be an ancestor of the accepted head, the recorded merge
tree must equal that head tree, and the merge must be reachable from the cumulative candidate on
the same epic. Re-read the actual policy blobs at those identities. PR numbers, labels, comments,
an issue's acceptance prose, a committed evidence file, branch names alone, and commit ordering
are not authorization. A direct policy commit on an epic branch has no accepting PR evidence.

Replay admissible policy deltas in accepted integration order, checking each against current
main policy. An independently changed main rule cannot be overwritten merely because an older
epic policy was accepted: a conflicting relaxation needs separate acceptance against the new
main rule. Apply unchanged inherited rules without widening them. Cumulative transitional and
stricter non-growth budgets also retain the smallest applicable count from main and the verified
accepted epic integration results where that path exists under the budget. The final candidate
cannot restore space removed by an earlier child. Durable budgets retain the latest admissible
exact maximum. Deleting and reintroducing a path does not reset its established ratchet.

These provenance rules govern every relaxation, including removing a stricter cap, increasing a
default, changing exception kind, resetting a ratchet, excluding a root or extension, reclassifying
maintained code as generated, or weakening a dependency rule. Missing or contradictory evidence
fails closed; implementing-agent prose, inline suppressions, and acknowledged warnings cannot
turn a failure into a pass.

Local verification resolves the same exact target and bounded accepting PR/CI metadata as CI
through read-only repository access, using credentials only through the existing environment
convention. CI binds these inputs to its actual PR event and tested candidate; local verification
binds them to its resolved delivery context. Caller-supplied SHAs or metadata are selectors to
validate against GitHub and Git, not trust assertions. Do not execute policy from an unvalidated
evidence location. The architecture checker owns architecture authorization comparison through
narrow evidence adapters. It reuses the existing coherent-CI-attempt and release-evidence policy
where those owners supply the same facts, rather than duplicating ADR-037/038 job selection,
attempt completeness, or candidate-identity rules. Architecture-specific epic and policy-diff
admission stays with the checker; reuse does not turn an epic acceptance into release authority.
This introduces no general evidence service, persistent authorization registry, merge bypass, or
new GitHub governance owner. Offline reporting may show provisional counts, but missing evidence
cannot produce a successful enforcing `npm run verify`.

#### Worked examples

1. **Bootstrap.** Main at `M0` and epic at `E0` contain an unchanged 1,400-line owner. A separate
   policy-only child proposes a transitional 1,400-line budget with its current owner, rationale,
   condition, and removal issue. Its checker and dedicated fixtures obey their existing/default
   limits. Verification admits the proposal because the consuming blob is identical at base and
   head; it rejects an unspecified 1,300-line sibling. After the focused policy PR passes coherent
   CI and is merged at `E1`, the budget is accepted for subsequent epic children. A durable
   1,600-line budget for the same unchanged owner would instead allow later growth up to 1,600.
2. **Consuming refactor.** A child based on `E1` reduces the transitional owner to 1,200 lines and
   passes the 1,400-line cap. Once accepted at `E2`, the next child has a 1,200-line cap. A return to
   1,250 fails. With the separately accepted durable 1,600 alternative, growth from 1,400 to 1,500
   passes; 1,601 fails. Raising it to 1,700 alongside the consuming edit fails regardless of
   commit order. A separately accepted policy-only PR with unchanged source can authorize 1,700
   after reaffirming cohesion and reconsideration. Ordinary PRs use the same sequence on main.
3. **Cumulative delivery.** The epic merges current main `M1`, then verifies its cumulative head.
   Although main lacks the bootstrap budgets, the verified policy PR at `E1` admits their exact
   delta. The accepted refactor at `E2` preserves the transitional 1,200-line ceiling, so a direct
   cumulative edit restoring 1,250 fails. Durable 1,600 remains admissible only with its accepting
   evidence. If `M1` independently tightened that owner's policy, the old epic authorization does
   not undo it. Missing PR/CI evidence, a wrong epic, changed policy blobs, or a policy commit
   followed by source edits within one unmerged PR all fail. The final PR still needs ordinary
   verification and maintainer acceptance to main; this evidence authorizes budgets only.

### Generated artifacts

Generated classification binds an exact output path to a named reproducible generator, its
maintained source or pinned tool, identified inputs, and regeneration command. Classification
verification validates that exact ownership and input identity; a banner alone is insufficient.
Regeneration evidence remains in the generator's owning workflow. This does not require every
`npm run verify` to regenerate outputs, fetch external source trees, or add a new environment
gate. Each generated artifact has an explicit separate blocking maximum appropriate to its
deterministic output. No implicit unlimited generated category exists. Without traceable
reproducible ownership, the file receives the ordinary maintained-source policy. Generator source
always receives maintained-source budgets. Generated reclassification or a larger generated
maximum follows the same separate policy-acceptance rules; regenerating within an accepted
maximum does not.

### Dependency graph and direction

Normal verification builds the repository's TypeScript/JavaScript module graph across the
maintained roots. Resolve statically identifiable local imports, re-exports, literal dynamic
imports and `require` edges using the actual module-resolution configuration. Classify runtime
edges by emitted behavior and preserve erased type references in the complete static graph;
`import type` is not the only possible erased reference. Unresolved local static edges are
reported errors, not silently dropped. Nonliteral runtime discovery is outside static cycle
proof and remains subject to the owning seam's authority rules.

- Every runtime strongly connected component with a cycle, including a self-loop, blocks normal
  verification. No warning acknowledgement suppresses it.
- The complete static graph reports all cyclic components and their runtime/type-only edges.
  A component whose cycle requires erased type edges is not automatically prohibited, even when
  some forward edges are runtime imports. It needs a coherent ownership disposition.
- Explicit seam and forbidden-direction rules apply to both runtime and type-only edges. Erasure
  cannot legalize a reversed dependency. Move misplaced contracts to capability-named leaf
  owners at the lowest layer their legitimate consumers can depend on.

Every static component present when the modular-architecture epic begins receives an explicit
disposition in its owning implementation issue/PR: eliminate an ownership inversion or retain a
coherent type-mediated relationship with permitted direction documented. New components receive
the same ownership assessment. Stable contracts point inward; generic shared type buckets and
mechanical `types.ts` extraction are not acceptable ways to make a graph green.

## Consequences

All maintained source has a predictable blocking ceiling, while the comfort signal keeps design
pressure visible without manufacturing false owners. Coherent large modules remain possible
through exact prior policy. Transitional debt shrinks; durable cohesion has an architectural
reconsideration condition rather than a ceremonial date.

Policy-only acceptance and cumulative provenance cost an additional focused review and bounded
read-only evidence lookup. Missing evidence blocks enforcement even when source counts look
acceptable. The bootstrap must enumerate every over-default module and give expired exceptions
a current disposition before later source work consumes them. This record itself authorizes no
current module budget and changes no checker or product behavior.

Static graphs expose ownership defects without treating every type relationship as executable
coupling. They complement ownership review and environment-appropriate tests; they do not prove
runtime behavior, eliminate lifecycle reasoning, or justify changing established public seams.

## Rejected alternatives

- Baseline-conditioned enforcement: age leaves maintained code without a governing limit.
- A universal hard 500-line cap: the comfort target is useful, but forced splits can reverse
  ownership or distribute one lifetime across artificial boundaries.
- Warning-only exceptions justified by the implementing agent: explanation is not prior authority.
- Treating 1,000 lines as proof of sound ownership: size cannot validate dependencies or lifetimes.
- Banning every type-only cycle: coherent erased relationships need review, while forbidden
  directions remain prohibited independently of cycles.
- Unbounded coherent exceptions: retained ownership needs an exact ceiling and reconsideration
  condition.
- Commit ordering or candidate-authored provenance as acceptance: neither proves separate review
  and integration of policy before consumption.
- Delaying governance for a synthetic multi-harness evaluation: existing maintenance constraints
  justify the policy without promising token savings or depending on an experiment.
