# Architecture budgets

ADR-040 owns the policy. `scripts/architecture-hotspots.json` records exact budgets;
`architecture-policy.mjs` validates and evaluates them, `architecture-inventory.mjs` owns
filesystem/Git reads, and `architecture-authorization.mjs` owns proposal and integration
admission. The GitHub adapter supplies bounded, read-only delivery and acceptance evidence.
It reuses the release evidence owner's exact candidate/tree checks and coherent CI-attempt
policy with the epic as its reachability target; this grants no release or merge authority.

Run an offline, explicitly provisional inventory with:

```sh
npm run architecture:report
npm run architecture:report -- --json
```

Every structured row includes its role, physical line count, governing rule, declared and
effective ceilings, comfort classification, result, and any exact exception metadata.
The text view lists exceptions, failures, and files above 500 lines and summarizes all files.
Reports do not claim that policy has been accepted. Missing or malformed source/policy still
fails visibly; offline reports cannot replace enforcing verification.

From the selected `agent/issue-N` worktree, supply the existing repository credential convention:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" npm run architecture:check
HVIR_REPO_TOKEN="$(gh auth token)" npm run verify
```

Local enforcement resolves the issue's native parent and exact live epic branch, or main for
an ordinary issue. The epic integration worktree resolves cumulative delivery to current main.
The target SHA must exist locally and be an ancestor of the candidate. Fetch and integrate a
changed target, then reverify; supplied or cached SHAs cannot establish authority. CI retains
its PR merge-ref checkout and proves its two parents, candidate tree, live PR metadata, and
event base/head before using the same evaluator. Credentials are never policy-file inputs.

All maintained TypeScript/declarations, JavaScript, CSS, shell scripts and shell-shebang hooks
are included across the ADR's roots and repository root. Existing native package C/header
source is explicitly governed by the same ordinary 1,000-line ceiling. An unknown extension
or non-shell executable shebang requires an explicit language disposition. JSON/YAML, prose,
HTML templates, build manifests, and binary/image assets are data rather than these source
families. Renaming code to an unsupported source extension fails inventory; data files are
not an alternate home for executable source. Added local files, even ignored maintained
source, count. Repository-owned aliases resolve once to their target; broken or escaping
aliases fail. Installed `node_modules`, Git internals, `out`, `dist`, coverage, and native
`packages/*/build` output are excluded by their disposable role. A tracked file under one of
those roles is an error, never a silent exemption.

The ordinary ceiling is 1,000 physical lines; 500 is a comfort signal. LF bytes are counted,
with one additional line for a nonempty unterminated final line. Blank/comment lines count;
CRLF and final newlines do not add phantom lines. Stricter named budgets and transitional
exceptions also retain their comparison-base non-growth cap. Accepted v2 target history
preserves reductions across deletion/reintroduction. Durable exceptions permit growth only
inside their exact accepted ceiling.

An exception specifies an exact path, maximum, capability owner, cohesion rationale, and
objective reconsideration condition. A transitional exception additionally names an open
removal issue. Its structural child removes the exception when the owner is removed or the
ordinary ceiling is a true tightening; retain a stricter named budget if removing it would
reopen a ratcheted ceiling below 1,000. Durable reservations may precede a new source path,
but the reserving policy PR cannot add that source itself.

A relaxation requires a separate policy-only PR. Its complete diff may touch only architecture
policy/checker modules, dedicated architecture tests/fixtures, this usage guide, and the exact
package/CI/Vitest verification wiring. Newly authorized existing consuming files must be
byte-identical to the comparison base. Changed checker and fixture source must obey prior
budgets or the ordinary default. This admission reports `policy-proposal`; it becomes usable
by consumers only after separate acceptance. Splitting policy and source into commits in one
PR does not qualify. Tightenings may accompany a consuming refactor.

Cumulative delivery reads accepted integrations in first-parent order. Every child integration
must have matching canonical GitHub PR, native parent, exact epic target, base/head/merge
identities, unchanged tested merge tree, and one coherent successful CI attempt. Policy
relaxations are replayed only from separately accepted policy-only children. Main's independently
changed rule cannot be weakened by older epic approval. Transitional/stricter reductions in
accepted children remain binding in the cumulative result. Missing/contradictory GitHub evidence,
direct policy commits, and candidate-authored evidence files confer no authority.

The generated terminal theme catalog has a separate 5,000-line ceiling. Its declaration names
the reproducible generator, exact input identities, and regeneration command. The generator
pins the upstream tree/archive identity and verifies it during its owning regeneration workflow;
normal verification checks maintained input identities and does not download or regenerate the
catalog. Regeneration within the accepted output/generator ownership and ceiling may update
input digests. A new generated classification, generator authority, or larger maximum needs
separate acceptance. Generator source always retains ordinary maintained-source treatment.

Focused policy, real temporary Git-history, and immediate GitHub-boundary fixtures run through
`npx vitest run test/architecture-*.test.js`; they need no network credentials. Normal
`npm run verify` retains its blocking architecture gate.
