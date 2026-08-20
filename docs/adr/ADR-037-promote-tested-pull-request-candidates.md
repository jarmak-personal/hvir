# ADR-037: Promote tested pull-request candidates

## Context

The same accepted change currently runs hvir's complete CI portfolio once as a pull-request
candidate and again after merge to `main`. Release preparation trusts the second run and downloads
its Linux packages. This duplicates correctness evidence, delays releases, and gives variable
GitHub-hosted runners another opportunity to fail without testing a distinct tree.

ADR-022 requires every published artifact, digest, installer, tag, version, and source commit to
belong to one immutable release. ADR-028 additionally requires native Ubuntu 22.04 builds for both
Linux architectures and installed acceptance of those exact packages on Ubuntu 22.04, Ubuntu
24.04, and Debian stable. Those guarantees remain required; their current CI cadence does not.

The repository is public but user-owned. GitHub supports repository rulesets and strict required
status checks here, including an expected GitHub Actions source and an empty bypass list. GitHub
[limits merge queues](https://docs.github.com/en/pull-requests/concepts/deploying-code#merging-code-into-the-release-or-main-branch)
to organization-owned repositories, so a merge queue is not available without changing repository
ownership. Strict checks instead require each accepted pull-request head to include the current
protected base before merge.

## Decision

### Merge trust

The `main` ruleset is the sole merge-enforcement owner. It continues to require a pull request,
blocks deletion and force-pushes, and has no bypass actors. It additionally requires checks from
GitHub Actions with GitHub's strict, up-to-date policy. Its one required status is
`CI / Merge acceptance`, the aggregate result for the complete ordinary merge portfolio.

An ordinary first-attempt CI run is accepted only when it belongs to this repository, the canonical
CI workflow and path, the `pull_request` event, the current `main` base, and the pull request's
current same-repository head SHA. Its required jobs are verification, Linux Electron smoke, macOS
arm64 Electron correctness, and CodeQL analysis. Every job must be present exactly once, completed,
and successful. The aggregate job runs even when a prerequisite fails or skips, and accepts only
workflow attempt one. A rerun of the same workflow execution therefore cannot replace failed CI or
CodeQL evidence; a changed head SHA is a new candidate and may produce its own first attempt.

The tested candidate is the pull-request merge commit checked out by the required jobs from
`github.sha`, not merely the branch head named by the workflow-run API. The workflow contract
requires every named job to use that default merge-ref checkout. Strict checks require the exact
base SHA recorded for the run to be an ancestor of its same-repository head SHA. That makes the
tested merge-ref tree exactly the head tree, so no additional manifest is needed. `main` permits
merge and squash merges, but not rebase merges. The resulting merge is eligible for promotion only
when it is the pull request's recorded merge commit and its Git tree is identical to that accepted
head tree. Commit identity may differ; tree identity may not. Direct pushes cannot satisfy the
pull-request rule or create promotable evidence.

The exact version-only automation path is the sole specialized exception. Its aggregate result
accepts only the existing trusted validator's exact repository, bot author, base, source, branch,
two-file change set, and synchronized version-content contract. Ordinary jobs, including CodeQL,
may skip only after that exact classification; the aggregate itself still runs and must succeed.
Any other identity or change takes the ordinary path.

The decision is fail closed:

| Evidence | Accepted | Rejected |
| --- | --- | --- |
| Repository and workflow | Canonical repository, named workflow and path | Wrong repository, head repository, workflow, path, or unrelated run |
| Event and attempt | Pull-request event, workflow attempt one | Push, dispatch, rerun-only, automatic or manual retry |
| Base and candidate | Merge ref tested from `github.sha`; recorded base is an ancestor of the exact PR head | Stale base, changed head, nonstandard checkout, changed tested tree, or ambiguous candidate |
| Ordinary required jobs | One completed successful instance of every named job | Missing, pending, failed, cancelled, skipped, neutral, or duplicate job |
| Merge | The same PR is merged and its recorded merge tree equals the tested candidate tree | Open, closed-unmerged, different merge, direct push, or unequal tree |
| Release source | Exact accepted merge commit reachable from `main` | Missing, unrelated, unmerged, ambiguous, or substituted source |

### Release trust and native certification

The Release workflow owns a narrow exact-source bridge because GitHub does not retain the tested
pull-request merge ref as a durable release identity. The existing release-evidence validator is
the only bridge owner. Given only the canonical repository, protected branch, and selected full
source SHA, it reads bounded GitHub pull-request and first-attempt workflow/job metadata, the exact
recorded base and head identities, and the corresponding Git commit and tree identities. It
requires the run head SHA to equal the merged pull request head, the recorded base to be its
ancestor, the selected source to equal the pull request's recorded merge commit, and the source tree
to equal the head tree. It accepts exactly one merged ordinary pull request that satisfies that
relation, or exactly one merged version-only pull request that satisfies the existing post-merge
validator. The bridge is not a reusable evidence service or general policy engine.

Native packages move to the release-candidate lifecycle. For the selected source, Release:

- builds Linux x64 and arm64 packages once on their native Ubuntu 22.04 runners;
- installs those same artifacts on Ubuntu 22.04, Ubuntu 24.04, and Debian stable for each
  architecture, preserving artifact digests across jobs;
- builds, signs, notarizes, staples, Gatekeeper-checks, installs, and removes the macOS arm64
  package in the protected signing environment; and
- assembles and publishes only that exact successful artifact set with the source, version, tag,
  installer, manifest, notices, names, and digests required by ADR-022.

Missing, failed, wrong-source, wrong-version, wrong-architecture, substituted, ambiguous, or
digest-mismatched native evidence blocks assembly and publication. Release consumes no package or
assembly artifact from ordinary CI.

### Cadence

Only these owners change cadence:

| Owner | Cadence and evidence | Consumer and failure behavior |
| --- | --- | --- |
| CI | Ordinary PR only; verification, Linux and macOS Electron, and CodeQL jobs feed one first-attempt aggregate result | The `main` ruleset and release bridge reject any missing or unsuccessful required job or mismatched tested tree |
| CodeQL schedule | Independent scheduled security analysis only; PR analysis is owned by CI and no `main` push analysis remains | Security reporting; it cannot create merge or release evidence |
| Release | Exact accepted merged source; Linux x64/arm64 `.deb` files, protected macOS arm64 `.pkg`, manifest, installer, notices, and digests | Assembly and publication reject an incomplete, substituted, or mismatched set |
| Capacity | Controlled machine only through `npm run gauntlet` / `npm run performance:capacity` | Maintainer release-readiness evidence; the exact candidate runs once and a crossing is not retried into a pass |

An unchanged accepted merge therefore schedules no second verification, Electron, CodeQL,
native-package, compatibility, or release-assembly run on the `main` push. Capacity contracts and
quantitative measurements remain together on the controlled path, so changing shared-runner
hardware is neither merge nor publication authority.

The manual Electron smoke-stress workflow and scheduled/manual real-host SSH acceptance retain
their existing cadences. Metadata, release dispatch, and other workflows may still react to a
`main` update only when they own a distinct event contract, not to repeat accepted correctness.

### Rollout

1. Add this decision without changing enforcement or workflow cadence.
2. Make Release build and accept its exact Linux and protected macOS packages, then remove the
   ordinary-CI native, compatibility, unsigned macOS, and unsigned assembly jobs and dependencies.
3. Put PR CodeQL and the other required jobs behind the first-attempt aggregate, enforce their
   merge-ref checkout contract, and add the exact-source validator while existing `main` CI still
   runs.
4. Configure the active `main` ruleset with the named strict check and no bypass, and prove an
   up-to-date ordinary pull request and the exact version-only exception can merge.
5. Remove the `main` push correctness triggers and hosted capacity job only after the preceding
   protections and release path are active.

No step removes evidence before its replacement owns the same trust boundary.

## Consequences

An accepted merge normally pays for one complete correctness portfolio, while a release pays for
the native artifacts and platform acceptance that apply specifically to what may ship. The release
validator gains one narrow PR-to-merge tree relation, but no database, scheduler, cache, reusable
workflow framework, or generic evidence abstraction.

Strict checks can require a fresh first attempt when another pull request advances `main`. A
genuine hosted-runner failure still blocks that candidate; changing the candidate, rather than
rerunning unchanged evidence, is the recovery path. Capacity regressions depend on maintainers
running the existing controlled gauntlet and are intentionally not inferred from dissimilar hosted
machines.

If the repository later becomes organization-owned, a merge queue may replace strict branch
updates only through a superseding decision that preserves first-attempt, exact-tree, and release
promotion guarantees.

## Rejected alternatives

- Keeping the complete `main` push matrix: it retests an unchanged tree and keeps Release coupled
  to duplicate CI artifacts.
- A merge queue now: GitHub does not offer it to this user-owned repository.
- Loose required checks: they permit a candidate tested against a stale protected base.
- Accepting reruns, allowed failures, retries, or longer readiness deadlines: they turn a failed
  attempt into different evidence without changing the candidate.
- Running native builds on every pull request: package installation and publication concern the
  exact release candidate, and cross-candidate artifacts are not release authority.
- Keeping capacity on GitHub-hosted runners or moving it into Release: either makes variable shared
  hardware a merge or publication authority.
- Path, label, changed-file, or estimated-risk selection: these heuristics can silently omit
  required ordinary correctness. The exact version-only validator remains the sole exception.
- Persisting a standalone evidence map, database, general validator, scheduler, policy engine,
  cache, or reusable workflow framework: the existing ruleset, workflows, and two narrow release
  validators already own the required decisions.
