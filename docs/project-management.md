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
- Valid open issues are added to the canonical Project when missing and their Kind value is
  reconciled.
- Closed issues retain their last Project Kind value. Reopening validates them again.
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

The command exits nonzero after printing its JSON report when any issue is missing a kind or has
ambiguous kind metadata. GitHub API failures, missing fields/options, archived items, permission
errors, and exhausted bounded retries also fail visibly.

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

The workflow's repository-scoped `GITHUB_TOKEN` receives only `contents: read` and
`issues: write`. GitHub does not allow that token to access a user-owned Project, so Project
access uses the `HVIR_PROJECT_TOKEN` secret from the `project-automation` environment. That
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
