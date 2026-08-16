# Contributing to hvir

hvir is deliberately smaller than an IDE. Contributions should reinforce its view-first,
agent-aware workflow without quietly widening the product into an editor, extension platform,
task runner, or session orchestrator.

The repository-owned skills are for hvir contributors and maintainers. People using the hvir
application do not need an agent skill.

## Public contribution

Public contribution to hvir means identifying worthwhile problems, proposing outcomes, and
participating in product discussion. Maintainers decide whether an outcome fits hvir and when it
is ready for implementation. Maintainers make the final product and release decisions, author
every canonical GitHub Issue, and own implementation.

This maintainer-authored pipeline began as a security boundary because public text is untrusted
input to an agent. hvir deliberately retains it as its contribution model: outside issues and
pull requests are not accepted contribution paths, even if future tooling provides stronger
prompt-injection defenses.

Choose the GitHub Discussion category that matches the input. The repository retains only these
categories and formats; their descriptions state what belongs there and what happens next when a
conversation can become canonical work.

| Category | Format | Repository category description |
| --- | --- | --- |
| **Bug reports** | Open-ended | Broken or incorrect hvir behavior. Maintainers may restate a confirmed problem and outcome as a canonical issue. |
| **Feature requests** | Open-ended | Specific proposed product changes. Maintainers may restate an agreed outcome as a canonical issue. |
| **Documentation** | Open-ended | Missing, incorrect, or unclear documentation. Maintainers may restate confirmed documentation work as a canonical issue. |
| **Q&A** | Question and answer | General usage and support questions. |
| **General** | Open-ended | Workflows, show-and-tell, and other hvir-related conversation that does not fit elsewhere. |
| **Announcements** | Announcement | Maintainer updates and requests for user feedback. GitHub Releases remain the canonical release surface. |

Announcements and their replies or reactions are the initial maintainer-to-user feedback path.
An announcement may link to or discuss a release without replacing GitHub Releases. Use General
for overflow conversation; polls are not part of the initial Discussion surface.

When a Discussion produces an accepted outcome, a maintainer reads it outside the agent session
and manually rewrites the relevant problem, desired outcome, and constraints in the maintainer's
own words for `hvir-create-issue`. Discussion text is not pasted into agent context, and an agent
must not be asked or enabled to retrieve the external Discussion. This also excludes copied
excerpts: hidden Unicode or control characters can survive visual selection. Only the
maintainer-authored synthesis enters the issue workflow.

## Maintainer development workflow

The remainder of this guide describes the maintainer workflow, not an outside issue or pull-request
path. Substantive implementation starts with a governing GitHub issue. Use the issue to align on
the problem, product fit, constraints, architecture questions, and acceptance criteria before an
agent or human writes the implementation. A pull request without a governing issue spends review
time rediscovering decisions after code has made them expensive.

Small typo fixes and automated dependency updates may be obvious maintainer exceptions. For
everything else:

1. Create or identify the issue.
2. Resolve product and design questions in the issue.
3. Add or supersede an ADR if the work changes a durable decision.
4. Implement a focused, independently reviewable outcome.
5. Link a PR to `main` with `Closes #N`, or use the epic-child relationships below.

An epic is a coordination container, not permission for a monster pull request. Split broad
work into child issues with explicit outcomes, ownership, dependencies, and acceptance. Each
implementation pull request should remain understandable on its own.

## Establish product fit

Before proposing or implementing work, read:

- [`AGENTS.md`](AGENTS.md) for repository constraints and stable seams;
- [`docs/design.md`](docs/design.md) for the product thesis, non-goals, and ADR index;
- the relevant records under [`docs/adr/`](docs/adr/README.md).

The design and ADRs are canonical. [`docs/plan/`](docs/plan/00-overview.md) preserves the
founding implementation history; it is not a current roadmap or acceptance tracker.

If a proposal conflicts with an ADR, say so early. It may be reasonable to discuss superseding
the decision, but implementation must not silently route around it. If the outcome violates an
explicit product non-goal, close that loop before asking anyone to write code.

## Use agents deliberately

The repository provides three lifecycle skills, one test-design skill, and two focused reviewers:

- `hvir-create-issue` evaluates product and ADR alignment, sharpens the problem and outcome,
  and prepares a discussion-ready issue.
- `hvir-implement-issue` performs architecture reconnaissance, raises design concerns before
  editing, and implements an aligned issue with verification.
- `hvir-implement-epic` privately coordinates an authorized epic's direct children through the
  single-issue workflow, coherence review, staged integration, cumulative handoff, and cleanup.
- `write-hvir-tests` selects the behavior owner and lowest real test altitude for test changes,
  fixtures, flake diagnosis, and test review.
- `hvir-review-issue` critiques broad issue drafts for hvir fit, scope, architecture creep,
  duplication, and unnecessary machinery.
- `hvir-review-code` critiques a ready implementation for correctness, issue fidelity,
  architecture, duplication, scope creep, and overengineering.

Claude discovers them under `.claude/skills/`; `.agents/skills/` exposes the same skills to
Codex-compatible harnesses. Read the governing documents before you use a skill.

Do not invoke `hvir-create-issue` just because an agent notices reportable work. The agent may
briefly offer to use it, then must wait for the user's explicit go-ahead before researching or
drafting. Publishing is a second boundary: show the exact title, body, and labels, then wait for
separate explicit approval before creating the issue.

Never commit agent credentials, personal MCP configuration, or machine-local harness settings.

The review skills normally run only when a maintainer invokes them. Explicit invocation of
`hvir-implement-epic` is the narrow exception: it authorizes that coordinator to apply
`hvir-review-code` selection policy once to eligible child candidates and once to the cumulative
candidate. `hvir-create-issue` and `hvir-implement-issue` do not independently invoke or suggest
review.

The canonical [agent-work measurement contract](docs/agent-work-measurements.md) defines the
forecast rubric, phase boundaries, provider-neutral usage vocabulary, append-only correction
rules, and Own/Rollup semantics shared by those lifecycle skills and repository tooling.

## Isolate issue implementation

`hvir-implement-issue` starts ordinary and epic-child work through one repository command:

```sh
npm run issue:start -- --issue N
npm run issue:start -- --issue N --apply
```

Planning refreshes/prunes remote-tracking refs and prints the complete setup without changing a
local branch, worktree, dependency tree, or Project value. Apply recomputes the current plan,
creates or reuses `agent/issue-N` at `<primary-repository>-worktrees/issue-N` from the exact
resolved start ref, and runs locked dependency preparation there. All implementation, testing,
verification, commits, pre-push checks, and pushes then happen in that selected worktree; the
invoking checkout and unrelated worktrees stay untouched.

The command composes the read-only delivery context with ordinary native Git status, worktree,
and ref operations plus bounded content-free PR evidence. Cleanup requires an inactive, unlocked
worktree; clean tracked and untracked state; only plainly disposable ignored artifacts; a gone
upstream; no open PR; and a merged PR that records the exact local head and that issue's expected
delivery base.
It never forces a Git operation or recursively deletes a worktree. Uncertain state is retained
with a reason and does not block an unrelated selected issue unless its branch or path collides.
This is a contributor convention, not a custom worktree registry or an hvir application
capability.

This lifecycle belongs only to repository contributor tooling. The hvir application continues
to discover worktrees without creating, moving, repairing, merging, or removing them.

## Stage epic delivery

Use `hvir-implement-epic` as the top-level workflow for an authorized open `kind:epic`. Its root
agent remains the private coordinator: it builds the child dependency/ownership graph, schedules
only independent work concurrently, reviews coherence, integrates child pull requests one at a
time, and prepares the cumulative maintainer handoff. It delegates every child implementation
through `hvir-implement-issue`; it does not define a second implementation workflow or put its
scheduling and reasoning record on GitHub.

The coordinator owns one `epic/N-slug` integration branch from current `main` and keeps its
history append-only. Each direct child's issue worktree starts at the current epic branch.
Ordinary issues continue to use `main`.

`hvir-implement-issue` uses `npm run issue:start -- --issue N` to plan a child's native parent,
exact base, deterministic issue branch and worktree, planning state, related open PRs, cleanup,
and dependency preparation. Add `--json` when an agent needs the structured record; pass
`--apply` only after reviewing the plan. `issue:context` remains available for read-only delivery
diagnosis. The epic coordinator creates or reuses the one unambiguous epic branch before child
startup; `issue:start` never creates or pushes it. Retain state and report a blocker when
metadata, refs, or worktrees conflict.

An epic-child PR targets the exact epic branch and names its direct child once:

```text
Completes-child: #<child>
```

Automation derives the open direct epic parent from GitHub's native relationship and validates the
PR base before changing issue state. Reserve `Closes` for PRs to `main`. Keep `Contributes-to: #N`
for partial work that does not complete an issue. Required CI and CodeQL checks run for `epic/**`
targets. Trusted automation uses default-branch code, treats PR text as data, and advances the
eligible child and parent records to `In Progress`.

The child workflow stops after preparing its focused pull request and compact handoff. The epic
coordinator validates the exact candidate, base, relationship, parent, reviews, and required
checks before merging one child at a time. Trusted automation revalidates the base and native
parent, then closes the direct child and converges Project Status to `Done`. Failed or ambiguous
validation keeps the child open. Reopen the child for an in-scope correction and return it through
`hvir-implement-issue`. No intermediate Project Status is used.

After every authorized child closes, the coordinator merges current `main` into the epic branch,
verifies and externally reviews the complete `main...epic` candidate, passes the pre-push gate,
and opens one final PR to `main` with `Closes #<epic>`. The maintainer owns cumulative acceptance
and the final merge. After the maintainer reports that merge, the coordinator cleans the epic
branch and worktree only after exact head, upstream, pull-request, and worktree safety checks.
Retain uncertain state for maintainer action.

## Develop locally

Development requires Node 24 or newer; release CI uses Node 24.

```sh
npm ci
npm run verify
npm run test:mutation    # opt-in pure-policy mutation evidence
npm run smoke
npm run smoke:macos        # matching Apple-silicon Mac
npm run smoke:macos:ci     # temporary reduced hosted macOS subset
npm run smoke:capacity     # contracts + machine-dependent evidence
npm run smoke:development-performance  # development-only timeline containment
npm run performance:capacity  # controlled-machine quantitative gate
npm run dev
```

`npm ci` downloads Electron and rebuilds native dependencies for Electron's ABI. On headless
Linux, run Electron smoke tests under `xvfb-run`. Install the optional pre-push smoke hook with:

On macOS, raw `npm run dev` and unsigned `npm run build:dir` are not the LAN SSH acceptance
identity. Use the
[signed macOS SSH coexistence workflow](docs/macos-ssh-acceptance.md), which fails closed when
its protected Developer ID signing inputs are unavailable.

```sh
npm run hooks:install
```

`npm run test:mutation` runs StrykerJS through the existing Vitest runner against the bounded
pure-policy modules listed in `stryker.config.json`; the initial scope is
`src/main/git/git-parsers.ts`. Its plain-text report gives the mutation score and identifies every
surviving mutant by file, line, mutator, and applied source change. Mutation testing measures
whether the tests constrain implementation behavior. It does not establish that the tests assert
the intended behavior.

This command is opt-in evidence: it stays outside `npm run verify` and pull-request CI, has no
blocking score threshold, and uses only Node and the locally installed test dependencies. It does
not launch Electron, require a display, or access the network.

`npm run smoke` runs the focused `pty-native`, `viewer-position`, `viewer-content`,
`git-workflow`, `workspace-remote`, `web-pane`, `renderer-authority`, `renderer-recovery`,
`document-review`, `terminal-presentation`, and `terminal-lifecycle` groups plus the transitional
`legacy-workflow` group in separate Electron processes with fresh project and user-data roots, then
reports a result for every scheduled group. Select one group locally with
`HVIR_SMOKE_SCENARIO=<name> npm run
smoke`; the complete name set is `pty-native`, `viewer-position`, `viewer-content`,
`git-workflow`, `workspace-remote`, `web-pane`, `renderer-authority`, `platform-contracts`,
`diagnostic-report-restart`, `renderer-recovery`, `document-review`, `development-performance`,
`terminal-presentation`, `terminal-lifecycle`, `legacy-workflow`, and `capacity`. The
development-performance group starts a development renderer and is run separately with `npm run
smoke:development-performance`; the restart scenario is reserved for the packaged multi-launch
fixture. `npm run smoke:macos` runs the focused PTY, viewer, Git, workspace/remote, web-pane,
renderer-authority, platform-contract, renderer-recovery, terminal-presentation, and
document-review, terminal-presentation, and terminal-lifecycle correctness groups.

Viewer and Git evidence follows the same ownership rule. `viewer-position` proves CodeMirror
virtualization, source/rendered/diff anchors, remounts, pending and empty diffs, scoped commands,
and find behavior. `viewer-content` proves ProjectHost reads and saves, worker-backed Shiki/JSON/CSV
rendering, bounded large-file paint, external reload, and Chromium HTML isolation. `git-workflow`
proves the real system-Git path for diff bases, changes, paged history, graph detail, dirty branch
refresh, sync controls, and blame. View-mode, navigation, anchor, Git parsing, graph, mutation, and
sync policy remain in their direct Vitest suites. Each focused process retains a bounded semantic
snapshot for timeout diagnosis.

Workspace, remote, web-pane, and renderer authority evidence follows the same split.
`workspace-remote` proves independently runnable project/workspace transitions, contained local
browse failures, missing-workspace suppression, synthetic SSH presentation, host-key trust,
host-qualified project registration, and close cleanup. Deterministic `ProjectHost` local/SSH,
reconnect, watcher, and late-completion policy remains in direct Vitest suites and never requires a
real SSH host. `web-pane` starts its own authorized terminal source and proves guest isolation,
authenticated routing, blocked navigation, ordinary input, full-page controls, workspace
hide/restore without reload, bounded redacted diagnostics, reserved close, and route cleanup.
`renderer-authority` owns real renderer reload/destruction revocation for routes and HTML previews;
it does not depend on a terminal scenario. Each focused process records a bounded semantic
snapshot when readiness fails.

`document-review` proves the production renderer/preload/IPC/store workflow, one shared
rendered/source Markdown anchor, tab/project/reload/restart durability, exact delivery preview,
provider framing through a real node-pty capture process, immutable destination authority, and
renderer/PTY cleanup. Exact revalidation branches, bounds, provider eligibility, deterministic
SSH transport behavior, and late-completion policy remain in their direct owning suites; the
opt-in real-host command retains the SSH server contract.

Terminal evidence remains split by its real owner. `pty-native` proves production-composed Custom
profile launch, output, termination event, and cleanup through Electron's node-pty ABI without a
window. `terminal-presentation` proves Ghostty startup, input, selection, split/focus, attention,
profile-menu, settings, and canvas behavior. `terminal-lifecycle` proves disconnect/reconnect
remount, recovery selection with same-process reattachment, renderer generations, and
webContents-destruction cleanup. Profile policy, recovery planning, split policy, and attention
policy remain in their direct Vitest suites.
The pre-push hook uses that full command on macOS. As a temporary containment while the observed
macOS presentation-readiness and native PTY teardown flakes are hardened, hosted macOS CI runs
`npm run smoke:macos:ci`, which omits terminal presentation and terminal lifecycle, and does not
run capacity. The workspace/remote, web-pane, and renderer-authority groups remain in that hosted
gate. Linux CI continues to gate on `npm run smoke:capacity`; both omitted macOS paths remain
directly runnable locally and are not treated as allowed failures.
`npm run smoke:capacity`
selects the capacity group: terminal
topology, presentation, delivery, exact input, cleanup, and recovery contracts remain blocking,
while CPU, latency, and working-set measurements are labeled evidence. CI invokes this command
on Linux; the temporary macOS containment above leaves it local-only there. `npm run
performance:capacity` runs the same contracts and samples
but enforces the quantitative budgets on a controlled machine. These commands use the same
aggregate launcher, so a failing group does not prevent reporting its scheduled siblings.
Each aggregate attempt is bounded: ordinary scenario processes receive three minutes, while the
capacity process receives ten minutes for its six 30-second CPU samples plus setup and teardown.

For a bounded local stress run, set `HVIR_SMOKE_REPEAT` to an integer from 1 through 100. For
example, `HVIR_SMOKE_SCENARIO=pty-native HVIR_SMOKE_REPEAT=20 npm run smoke:scenario` schedules 20
iterations of that group. Each iteration launches a fresh Electron process with fresh project and
user-data roots. Iterations are fixed stress evidence, not retries: every scheduled iteration runs,
and any failed iteration makes the aggregate command fail. Pull-request jobs omit the variable and
therefore run one iteration. Aggregate output includes every attempt and its duration.

The `Electron smoke stress` workflow accepts one bounded scenario/count through manual dispatch on
Linux x64 and macOS ARM64. It has no schedule: normal exact-SHA CI and release evidence is already
the recurring signal, while repetition is reserved for a suspected boundary that needs targeted
diagnosis. It is stress evidence, not a reliability-percentage claim, pull-request gate, or retry
loop. On failure, the launcher writes one JSON artifact per failed attempt when
`HVIR_SMOKE_ARTIFACT_DIR` is set. The
closed artifact contains the scenario and iteration, expected outcome, duration, process exit,
last safe semantic phase, owned-resource counts/flags, and reviewed log-event booleans. It never
retains raw logs, environment values, terminal transcripts, source/diff/file bodies, requests,
cookies, headers, form values, console contents, or screenshots.

Use `npm run smoke:isolation` for the real-process interruption proof. It stops focused PTY,
Git/renderer-watch, and web-route scenarios at controlled owner checkpoints, exercises a
scenario failure, graceful `SIGHUP`/`SIGINT`/`SIGTERM`, and process-group `SIGKILL`, then runs all
three clean successors in parallel. Graceful paths must report reverse-order disposal and dead
process groups. The force-killed path
claims no in-process cleanup: its uniquely named temporary root must carry the exact hvir
ownership marker, remain inert, never be reused by a successor, and pass marker-and-parent
validation before bounded removal. The command records only closed resource counts, generation,
route/port state, process outcome, and cleanup names; it does not capture terminal, file, web, or
environment content.
Deferred PTY-spawn and renderer-generation tests remain at their domain seams to prove that late
completion after revocation fails closed and cannot recreate disposed authority.

Real SSH server behavior is an opt-in acceptance boundary, not a pull-request dependency. Run
`npm run acceptance:ssh:real-host` only with an explicit target:

- `HVIR_REAL_SSH_HOST`, `HVIR_REAL_SSH_PORT`, and `HVIR_REAL_SSH_USER` identify the target;
- `HVIR_REAL_SSH_HOST_KEY` is the exact trusted `SHA256:` fingerprint;
- `HVIR_REAL_SSH_ROOT_PARENT` is an existing absolute directory reserved for disposable runs; and
- exactly one of `HVIR_REAL_SSH_PRIVATE_KEY` or `HVIR_REAL_SSH_IDENTITY_FILE` supplies the key.
  `HVIR_REAL_SSH_PASSPHRASE` is optional for an encrypted key.

The command never reads ambient SSH config, agents, default hosts, passwords, or trust stores. It
exits with status 2 and reports `unavailable` when all target settings are absent; a partial or
invalid configuration fails. One logical `SshHost` then exercises exec, SFTP, real watch/poll,
supervised PTY plus provider observation, direct loopback streaming, pooled transport capacity,
and explicit disconnect/reconnect. Every remote file stays under a fresh host-qualified project
root. The target must provide POSIX `sh`, SFTP, and `python3`; Python runs only one bounded
in-memory loopback server and is not installed or retained by hvir. Cleanup requires the exact
per-run ownership marker before removing that root, stops all streams/PTYs/watches, disconnects
transports, and installs no remote service. `SIGHUP`, `SIGINT`, and `SIGTERM` enter that same
bounded cleanup path instead of exiting around it. Failure output and
the optional `HVIR_REAL_SSH_ARTIFACT_DIR` artifact contain only the closed phase and failure
reason, connection/watch state, resource counts/flags, transport counts, and duration—never
target configuration, credentials, fingerprints, paths, terminal output, or remote file contents.

The monthly/manual `Real-host SSH acceptance` workflow reads the same values from the protected
`real-host-ssh` environment. With no configured target its acceptance job is visibly skipped; a
partially configured target fails the availability job. This leaves deterministic `SshHost` and
transport tests as the first pull-request evidence while keeping mutable infrastructure outside
the universal gate.

Native package acceptance is the distribution boundary, not a second product workflow. On a
disposable matching host, build the native package and run `npm run smoke:linux:installed` or
`npm run smoke:macos:installed` with the guarded environment documented in
[`docs/packaging.md`](docs/packaging.md). These checks exercise installer-owned install, update,
ordinary launch, `hvir .`, migration, uninstall, reinstall, and purge behavior. They inspect the
actual package for production worker entrypoints and the matching native PTY payload but do not
execute either from the installed artifact. Real worker round trips and native PTY lifecycle stay
in the matching-target unpackaged Electron groups.

Use `npm run gauntlet` for the full release gate on a controlled machine; it includes
`performance:capacity`. Packaging and performance work has additional acceptance guidance in
[`docs/packaging.md`](docs/packaging.md) and
[`docs/phase8-performance-gauntlet.md`](docs/phase8-performance-gauntlet.md).

## Maintain the ghostty-web compatibility pin

The `Update ghostty-web compatibility artifact` workflow checks the public compatibility fork
daily and by manual dispatch. It accepts only the newest immutable, published, non-prerelease
`hvir-v<package-version>-<revision>` release with exactly one package tarball, checksum, and
provenance record. Before changing a branch it verifies the release tag and source commit, every
asset digest, the tarball checksum, provenance and package identity, npm lock integrity, a clean
`npm ci`, and the existing terminal-runtime contract.

Candidate installation and runtime checks run in an unprivileged preparation job that has no App
credentials. A fresh publication job receives the short-lived App token, rechecks the exact base
commit and pull-request state, independently revalidates the public immutable release, verifies
the hashes and exact transformation of the fixed four-file candidate bundle, and publishes it
without installing dependencies or executing candidate code.

The workflow rebuilds `automation/ghostty-web-update` from current `main` and maintains at most
one marked pull request. A newer release advances that same branch and pull request; closing an
unwanted update suppresses that release until a newer one appears. Generated pull requests are
the documented automated-dependency exception: they intentionally have no governing issue or
closing relationship, never merge automatically, and pass through the ordinary pull-request,
planning, CodeQL, Electron, capacity, packaging, release-assembly, branch-protection, and
maintainer-review gates.

Repository administration must provide a dedicated GitHub App installed only on hvir. Grant the
App repository metadata read, contents write, and pull-request write permissions only. Do not
grant Actions, administration, secrets, environments, issue, or direct default-branch authority.
Create a `ghostty-web-updates` environment restricted to `main`, put the App client ID in the
`HVIR_GHOSTTY_WEB_APP_CLIENT_ID` environment variable, and put its private key in the
`HVIR_GHOSTTY_WEB_APP_PRIVATE_KEY` environment secret. The workflow requests only the two write
permissions from the short-lived installation token and revokes it at job cleanup.

After provisioning or rotation, manually dispatch the workflow from `main`. When the fork's
newest release is already pinned, a successful run must report a no-op without creating or
changing a pull request. Missing credentials, malformed or transient release evidence, multiple
owned pull requests, an incompatible artifact, or any candidate check fails closed without
changing `main`.

## Protect the architecture

ADR-014 defines hvir as a modular monolith organized by product capability. Before editing,
trace the behavior, identify its current owner and public seam, inspect callers, and search for
equivalent policy or helpers. Share one stable concept through a narrow, domain-named module;
do not create generic `utils`, catch-all `services`, or a service locator.

Composition roots wire owners and adapters; they do not implement workflows. Cross-feature
coordination belongs in a named coordinator with narrow ports. Resource ownership and cleanup
must be explicit, late async completion must be rejected after revocation, and paths remain
host-qualified through `ProjectHost`.

Run `npm run architecture:report` before and after structural work. The hotspot budgets are
blocking non-growth ratchets and review signals, not targets and not a substitute for judging
ownership. Extract responsibilities rather than moving arbitrary blocks into smaller files.

## Verify at the owning seam

Use the repository-owned
[`write-hvir-tests`](.claude/skills/write-hvir-tests/SKILL.md) skill when designing, changing,
diagnosing, or reviewing tests. It contains the procedural workflow and stable behavior-altitude
matrix; this section keeps only the concise contributor rule.

Tests should match the behavior's real boundary:

- test pure policy directly;
- fake narrow ports when testing feature consumers;
- fake only immediate external dependencies for adapters;
- keep Electron, Chromium, cross-process, renderer-destruction, SSH, and real-transport
  contracts at integration, smoke, or real-host altitude.

Run `npm run verify` after the final changes and before committing. This is a required local gate.
Then push without `--no-verify` so the repository pre-push hook runs typechecks and the
local-platform Electron smoke; if hooks are not installed, run `.githooks/pre-push` directly
before pushing. Fix failures locally or report an environment blocker rather than using CI to
discover a known failure.

Use capacity, real-host, packaged, or gauntlet checks when the issue's acceptance criteria call
for them. CI reports verification, Electron correctness, deterministic capacity contracts, and
machine-dependent capacity evidence without turning a hosted measurement crossing into a failed
gate. `npm run gauntlet` remains the combined controlled-machine release gate. Report exact
evidence and any environment you could not verify; never imply a check ran when it did not.

## Open a focused pull request

Use the pull-request template. Keep the diff scoped to the governing issue, preserve unrelated
work, and explain:

- why the outcome belongs in hvir;
- the owner, seams, dependency direction, and reuse decisions;
- security, failure, lifecycle, responsiveness, and local/SSH behavior where relevant;
- exact validation results and any remaining gaps.

Durable decisions belong in ADRs. Progress notes, implementation detail, and test evidence
belong in the issue, commits, and pull request.
