# GitHub project management

hvir uses [GitHub Project 1](https://github.com/users/jarmak-personal/projects/1) as its
canonical planning Project. Issues are the planning records; repository labels remain the
source of truth for categorical metadata.

## Categorical metadata

Every open issue should have exactly one recognized `kind:*` label and may have any number of
`area:*` labels. Kind labels are projected one way into the Project's exclusive `Kind`
single-select field:

| Repository label | Project option |
| --- | --- |
| `kind:epic` | `Epic` |
| `kind:feature` | `Feature` |
| `kind:bug` | `Bug` |
| `kind:refactor` | `Refactor` |
| `kind:docs` | `Docs` |
| `kind:maintenance` | `Maintenance` |
| `kind:enhancement` | `Enhancement` |

The `Kind` field is useful for exclusive grouping and charts. It is derived data: changing it
in the Project does not change repository labels, and the next reconciliation overwrites drift.

Area labels stay multi-valued and are not flattened into a custom field. Project views use
GitHub's native boolean filtering. For example, the saved
[Feature requests · Terminal](https://github.com/users/jarmak-personal/projects/1/views/3)
view uses:

```text
is:open AND (label:"kind:feature" OR label:"kind:enhancement") AND label:"area:terminal"
```

## Kind policy

- Adding a recognized kind makes that label authoritative and removes other `kind:*` labels.
- Removing the sole recognized kind restores it. Add the replacement kind first when changing
  classification.
- Creating or reopening an issue without a kind reports an error; automation does not guess.
  Because issue creation is maintainer-only and blank issue creation is disabled, a kindless
  `opened` event intentionally fails its workflow run. Applying a recognized kind triggers a
  succeeding reconciliation.
- Manual reconciliation reports missing, unsupported, and competing kinds without choosing one.
- Open issues are added or restored in the canonical Project when needed. Their Kind is derived
  from the repository label, and blank or stale completed Status values converge to `Todo`.
- Closed issues with an active Project item retain their label-derived Kind and converge to
  `Done`. Reopening converges them back to open-work planning before PR relationships are applied.
- A delayed event whose issue timestamp is older than current GitHub state is treated as a
  non-destructive reconciliation, not replayed as a label transition.

## Repository interface

### Kind reconciliation

The repository-owned kind command defaults to a dry run:

```sh
npm run project:kind -- --issue 83
npm run project:kind
```

Pass `--apply` only after reviewing the report:

```sh
npm run project:kind -- --issue 83 --apply
npm run project:kind -- --apply
```

The command reads credentials only from `HVIR_REPO_TOKEN` and `HVIR_PROJECT_TOKEN`. It never
accepts tokens as command-line arguments or logs IDs, tokens, raw API responses, issue titles,
or issue bodies. For a local maintainer run, the existing GitHub CLI credential can be supplied
without writing it to disk:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run project:kind -- --issue 83
```

The command prints one concise result by default. Use `--verbose` for per-issue human diagnostics
or `--json` for the structured report. It exits nonzero when any issue is missing a kind or has
ambiguous kind metadata. GitHub API failures, missing fields/options, irreconcilable closed-item
membership, permission errors, and exhausted bounded retries also fail visibly.

### Normalized planning records

An agent or maintainer can read one issue and its canonical Project state without knowing
GitHub node IDs, Project item IDs, field IDs, option IDs, or GraphQL unions:

```sh
npm run project:record -- --issue 85
```

The structured JSON record contains only repository and issue identity, open/closed state,
recognized kind metadata, sorted multi-valued `area:*` labels, native parent/sub-issue
relationships, native linked pull requests, Project membership, and named `Kind` and `Status`
values. It deliberately omits issue and pull-request titles, bodies, comments, and internal
GitHub IDs. Native pull-request relationships are reported as `closing` unless GitHub reports
them as manually `linked`; closed and merged pull requests remain visible.

Project membership has three explicit states:

- `missing`: the issue has no item in the canonical Project;
- `archived`: its canonical item exists but is archived; and
- `present`: its canonical item exists and is active.

A read never changes membership. Add or restore an eligible open issue only by requesting the
named operation; it remains a dry run unless `--apply` is also present:

```sh
npm run project:record -- --issue 85 --ensure-project
npm run project:record -- --issue 85 --ensure-project --apply
```

`Status` is the only writable planning value. The command accepts the canonical option names
`Todo`, `In Progress`, and `Done`, skips an existing value, and reports its operation as
`would-update`, `updated`, or `unchanged`:

```sh
npm run project:record -- --issue 85 --status 'In Progress'
npm run project:record -- --issue 85 --status 'In Progress' --apply
```

Setting Status on a missing or archived item requires `--ensure-project`, so membership intent
cannot be inferred from a field update. Missing or archived closed issues cannot be added or
restored. Direct Project `Kind` writes are rejected because repository labels remain its owner.
Apply operations are sequential, not transactional: if add/restore succeeds and a later Status
write fails, the membership change remains and a retry resumes idempotently from current state.

On a successful apply, the command re-reads the item and `record` reflects the confirmed Project
values. In dry-run output, `record` remains the observed state and `operations` describes the
proposed changes. A valid read, dry run, applied update, or no-op exits 0. Invalid input, missing
repository/Project access, schema drift, archived/missing mutation intent, GraphQL failures, and
exhausted bounded retries exit 1 with an actionable diagnostic.

The planning-record and kind commands share the same bounded GitHub request, pagination,
canonical Project lookup, schema-validation, item-lookup, and token-redaction mechanics. Each
command remains one process per consumer operation; lookup and mutation steps are not separate
runner jobs.

Both commands use `HVIR_REPO_TOKEN`, `HVIR_PROJECT_TOKEN`, `HVIR_REPOSITORY`,
`HVIR_PROJECT_OWNER`, and `HVIR_PROJECT_NUMBER` as documented above. Credentials are read only
from the environment and are never accepted as command-line values.

### Delivery context

Read the complete implementation context for one issue before selecting a base or worktree:

```sh
npm run issue:context -- --issue 168
npm run issue:context -- --issue 168 --json
```

The command uses the same repository and Project environment values as `project:record`.
The concise human output is the default. The JSON form reports the issue, native parent, ordinary
or epic-child path, exact expected PR base, deterministic `agent/issue-N` branch and sibling
worktree, related open PRs, canonical planning state, and actionable conflicts. The command exits
2 when a conflict blocks safe delivery. It never mutates repository or Project state.

For ordinary issues the expected PR base is `main`; implementation starts from `origin/main`.
For a direct child of an open `kind:epic`, the expected base is the one unambiguous live
`epic/<parent>-<slug>` branch. Missing or multiple branches, nested epics, closed or invalid
parents, mismatched Project state, and open related PRs on the wrong base are explicit conflicts.
The report omits bodies, comments, credentials, internal IDs, and raw API responses.
When invoked from the primary checkout or deterministic sibling issue worktree, the command
infers the primary root without running Git. Set `HVIR_PRIMARY_ROOT` only for a nonstandard local
layout.

## Pull request relationships and Status

Issues remain the canonical planning records; pull requests are relationship and lifecycle
signals and do not need to be Project items. A PR can relate to same-repository issues in three
explicit ways:

- GitHub's native closing references (`Closes #86`, `Fixes #86`, and their documented keyword
  equivalents) mean that the PR completes the issue. Automation consumes GitHub's resolved
  `closingIssuesReferences`; it does not re-parse closing keywords.
- An exact whole-line `Contributes-to: #N` trailer means that the PR contributes work without
  completing the issue. Multiple trailers are allowed:

  ```text
  Contributes-to: #50
  Contributes-to: #87
  ```
- An epic-child PR uses one exact whole-line `Completes-child: #N` trailer. Automation derives
  the child's open direct epic parent from the native relationship, resolves the one matching
  epic branch, and requires the PR to target that exact base.

The contribution spelling and capitalization are deliberate. Up to three leading spaces and
trailing whitespace are accepted, but the remainder of the line must be exactly
`Contributes-to: #N`, where `N` is a positive same-repository issue number other than the PR
number. Free-form prose, fenced or indented code examples, and HTML comments are ignored.
Malformed, cross-repository, and self-referencing relationships are errors; duplicate
contribution trailers are deduplicated with a warning. A completing-child relationship must name
one direct child exactly once. If one issue is both a completion and contribution target,
completion semantics take precedence.

Status ownership follows the canonical issue and PR signals:

| Current event or state | Related issue behavior |
| --- | --- |
| PR opened, reopened, draft, or ready for review | An eligible open `Todo` issue advances to `In Progress`. |
| Relationship added or edited | Current GitHub relationships are recomputed; eligible targets advance. |
| Ordinary completion PR merged to `main` | Native issue closure owns completion; the issue event converges Project `Done`. |
| Completing-child PR opened against its exact epic base | The direct child and derived parent epic converge to `In Progress`. |
| Completing-child PR merged after exact validation | Trusted automation closes the direct child; the same lifecycle policy converges Project `Done`. |
| Contribution PR merged | The contributed issue stays open and advances from `Todo` to `In Progress` when needed. |
| PR closed unmerged or contribution removed | Current relationships are recomputed, but Status is never automatically regressed. |
| Issue reopened | Current open completion, completing-child, and contribution relationships are recomputed before any advance. |

Normal issue and PR events converge Project membership, label-derived Kind, and lifecycle Status.
Open work starts at `Todo`, active explicit PR relationships advance it to `In Progress`, and
closed issue state owns `Done`. Removing or closing a PR relationship never demotes an already
open `In Progress` issue. Missing or archived open items are added or restored; a closed issue
without an active item is a visible conflict because automation cannot safely invent historical
membership. Multiple PRs for one issue and one PR for multiple issues are resolved from current
GitHub state rather than replaying event assumptions.

Epic-child PRs target a bounded `epic/**` branch and use one `Completes-child: #N` trailer. The
trusted relationship workflow derives the parent epic and advances both records while the PR is
active. After merge, it revalidates the exact base and native parent before closing the child.
Failed or ambiguous validation leaves the child open and reports the conflict. Reopen the child if
a correction makes its outcome incomplete; a new completing-child PR advances eligible reopened
work normally. `Contributes-to: #N` remains available for partial, non-completing work. No
intermediate Project Status is used.

Inspect a PR relationship reconciliation without mutation:

```sh
npm run project:pr -- --pull-request 86
```

Apply the eligible transitions after reviewing the report:

```sh
npm run project:pr -- --pull-request 86 --apply
```

Reconciliation emits one concise line by default. Add `--verbose` for per-target diagnostics or
`--json` for the complete structured report.

A reopened issue can be reconciled directly with `--issue N`. On an edited event, the workflow
passes the previous body through an environment value only so the command can report a removed
contribution; it always queries the current PR, issue relationships, open PR bodies, and Project
record before deciding. Reports contain issue/PR numbers, named states, fixed diagnostics, and
operation outcomes, but never titles, bodies, comments, tokens, node IDs, or raw API responses.

Valid targets are processed independently and deterministically. A malformed trailer or one
missing, archived, inaccessible, or cross-repository target does not suppress valid transitions
from the same event, but the command exits 2 after printing the complete report so the partial
failure remains visible. Failures before a report can be constructed exit 1. Retrying is
idempotent.

## Project schema provisioning

The custom categorical schema has one single-select field named exactly `Kind`, with the seven
options listed above. A maintainer with Project write access can provision it once with:

```sh
gh project field-create 1 \
  --owner jarmak-personal \
  --name Kind \
  --data-type SINGLE_SELECT \
  --single-select-options 'Epic,Feature,Bug,Refactor,Docs,Maintenance,Enhancement'
```

Runtime automation does not create or silently repair schema. A missing field, wrong field type,
or renamed/missing option is an actionable failure so schema drift is reviewed deliberately.
The planning-record command also expects the canonical Project's `Status` single-select field to
contain `Todo`, `In Progress`, and `Done`; it does not create or rename those options.
Duplicate items for one repository issue fail both planning-record and kind commands visibly
rather than allowing an arbitrary item to win.

## Actions authentication and usage

`.github/workflows/project-kind.yml` has two paths:

- one five-minute job for a relevant issue event; and
- one ten-minute manual job for either a single issue or all open issues.

There is no polling and no runner-per-primitive fan-out. Per-issue concurrency serializes
overlapping event jobs without cancelling an in-flight reconciliation. Reads resolve current
state first, and no-op label or Project mutations are skipped.

`.github/workflows/project-pr-planning.yml` has one event job for the relevant PR lifecycle
events targeting `main` or `epic/**`, or an issue reopen, plus one manual PR reconciliation job.
Event jobs apply automatically; manual dispatch is a dry run unless `apply` is selected. A
repository-wide concurrency group serializes Project Status work without cancelling an in-flight
job. Each event uses one runner. PR events load the current triggering PR and its paginated native
relationships; both PR and issue-reopen paths scan paginated open PR bodies once for current
contribution and completing-child trailers and batch all issue operations inside that job. There
is no polling or runner-per-relationship fan-out.

The workflows' repository-scoped `GITHUB_TOKEN` receives only `contents: read`, bounded
`issues: write`, and PR metadata read where required. GitHub does not allow that token to access a
user-owned Project, so Project access uses the `HVIR_PROJECT_TOKEN` secret from the
`project-automation` environment. That
environment accepts only the `main` branch. Create a classic personal access token owned by the
Project owner with the GitHub-documented `project` and `repo` scopes, then store it as an
environment secret:

```sh
gh secret set HVIR_PROJECT_TOKEN --env project-automation --repo jarmak-personal/hvir
```

After confirming the environment secret exists, remove any repository-scoped copy so a workflow
on another ref cannot bypass the environment boundary:

```sh
gh secret list --env project-automation --repo jarmak-personal/hvir
gh secret delete HVIR_PROJECT_TOKEN --repo jarmak-personal/hvir
```

Rotate the token through the environment's Actions secrets settings. Do not reuse a broader
interactive maintainer token as the secret.

Issue titles, bodies, comments, and label text are treated as data. Event values enter the
command through environment variables rather than generated shell source. Third-party actions
are pinned to full commit SHAs. Both jobs check out `main` explicitly without persisting the
`GITHUB_TOKEN`; manual dispatches from any other ref are rejected.

The PR workflow uses `pull_request_target` because a fork-originated PR must be able to trigger
the user-owned Project mutation. This is a privileged metadata workflow: GitHub loads the
workflow from the default branch, the job checks out only trusted `main`, and it never checks out,
fetches, installs, builds, or executes PR code. The job disables package-manager caching and gives
`GITHUB_TOKEN` read-only `contents` and `pull-requests` access plus bounded `issues: write` access
for validated direct-child closure. The Project credential remains isolated in the main-only
`project-automation` environment; the event's
`GITHUB_REF` remains the default branch even when the PR base is `epic/**`. PR bodies and the
prior-body event value are parsed only as data by static default-branch automation; event values
are passed through environment variables and never interpolated into shell source. External
actions remain pinned to full commit SHAs.
