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
- Manual reconciliation reports missing, unsupported, and competing kinds without choosing one.
- Valid open issues are added to the canonical Project when missing and their Kind value is
  reconciled.
- Closed issues retain their last Project Kind value. Reopening validates them again.
- A delayed event whose issue timestamp is older than current GitHub state is treated as a
  non-destructive reconciliation, not replayed as a label transition.

## Repository interface

The repository-owned command defaults to a dry run:

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

## Project schema provisioning

The canonical schema has one single-select field named exactly `Kind`, with the seven options
listed above. A maintainer with Project write access can provision it once with:

```sh
gh project field-create 1 \
  --owner jarmak-personal \
  --name Kind \
  --data-type SINGLE_SELECT \
  --single-select-options 'Epic,Feature,Bug,Refactor,Docs,Maintenance,Enhancement'
```

Runtime automation does not create or silently repair schema. A missing field, wrong field type,
or renamed/missing option is an actionable failure so schema drift is reviewed deliberately.

## Actions authentication and usage

`.github/workflows/project-kind.yml` has two paths:

- one five-minute job for a relevant issue event; and
- one ten-minute manual job for either a single issue or all open issues.

There is no polling and no runner-per-primitive fan-out. Per-issue concurrency serializes
overlapping event jobs without cancelling an in-flight reconciliation. Reads resolve current
state first, and no-op label or Project mutations are skipped.

The workflow's repository-scoped `GITHUB_TOKEN` receives only `contents: read` and
`issues: write`. GitHub does not allow that token to access a user-owned Project, so Project
access uses the repository secret `HVIR_PROJECT_TOKEN`. Create a classic personal access token
owned by the Project owner with the GitHub-documented `project` and `repo` scopes, store it as
that Actions secret, and rotate it through the repository's Actions secrets settings. Do not
reuse a broader interactive maintainer token as the secret.

Issue titles, bodies, comments, and label text are treated as data. Event values enter the
command through environment variables rather than generated shell source.
