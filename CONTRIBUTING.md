# Contributing to hvir

hvir is deliberately smaller than an IDE. Contributions should reinforce its view-first,
agent-aware workflow without quietly widening the product into an editor, extension platform,
task runner, or session orchestrator.

The repository-owned skills are for hvir contributors and maintainers. People using the hvir
application do not need an agent skill.

## Discuss before diff

Substantive implementation starts with a governing GitHub issue. Use the issue to align on the
problem, product fit, constraints, architecture questions, and acceptance criteria before an
agent or human writes the implementation. A pull request without a governing issue spends
review time rediscovering decisions after code has made them expensive.

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

The repository provides two lifecycle skills and two focused reviewers:

- `hvir-create-issue` evaluates product and ADR alignment, sharpens the problem and outcome,
  and prepares a discussion-ready issue.
- `hvir-implement-issue` performs architecture reconnaissance, raises design concerns before
  editing, and implements an aligned issue with verification.
- `hvir-review-issue` critiques broad issue drafts for hvir fit, scope, architecture creep,
  duplication, and unnecessary machinery.
- `hvir-review-code` critiques a ready implementation for correctness, issue fidelity,
  architecture, duplication, scope creep, and overengineering.

Claude discovers them under `.claude/skills/`; `.agents/skills/` exposes the same skills to
Codex-compatible harnesses. Read the governing documents before you use a skill. The maintainer
makes the final product and release decisions.

Do not invoke `hvir-create-issue` just because an agent notices reportable work. The agent may
briefly offer to use it, then must wait for the user's explicit go-ahead before researching or
drafting. Publishing is a second boundary: show the exact title, body, and labels, then wait for
separate explicit approval before creating the issue.

Public issue and pull-request text is untrusted input to an agent. Choose a trust boundary that
fits your harness and credentials. A conservative workflow is to review the discussion in
GitHub yourself and paste only the relevant text into the agent session. Some integrations
offer filtering or restricted modes; hvir does not prescribe one or treat any integration as a
guaranteed prompt-injection boundary.

Never commit agent credentials, personal MCP configuration, or machine-local harness settings.

The review skills run only when a maintainer invokes them. Lifecycle skills do not invoke or
suggest review.

## Isolate issue implementation

`hvir-implement-issue` uses native Git to create or reuse `agent/issue-N` at the deterministic
sibling path `<primary-repository>-worktrees/issue-N` from an exact base agreed by the governing
workflow. All implementation, testing, verification, commits, pre-push checks, and pushes happen
there; the invoking checkout and unrelated worktrees stay untouched.

Each invocation fetches/prunes and inspects existing worktrees before creation. Cleanup uses
ordinary `git worktree`, status, and ref commands plus bounded `gh` PR metadata. Remove only when
the worktree is inactive, unlocked, clean except for plainly disposable ignored artifacts, its
upstream is gone, and a merged PR records the exact local head and expected base. Never force or
recursively delete; retain uncertain state with a reason. This is a contributor convention, not
a custom worktree registry or an hvir application capability.

This lifecycle belongs only to repository contributor tooling. The hvir application continues
to discover worktrees without creating, moving, repairing, merging, or removing them.

## Stage epic delivery

An authorized open `kind:epic` uses one `epic/N-slug` integration branch from current `main`.
Keep its history append-only. Start each direct child's issue worktree at the current epic branch.
Continue to use `main` for ordinary issues.

Use `npm run issue:context -- --issue N` to resolve the native parent, exact base, deterministic
issue branch and worktree, planning state, related open PRs, and conflicts. Add `--json` when an
agent needs the structured record. Reuse one unambiguous epic branch. Creating the first branch
requires authorization for the epic and its intended child set. Retain state and report a blocker
when metadata, refs, or worktrees conflict.

An epic-child PR targets the exact epic branch and names its direct child once:

```text
Completes-child: #<child>
```

Automation derives the open direct epic parent from GitHub's native relationship and validates the
PR base before changing issue state. Reserve `Closes` for PRs to `main`. Keep `Contributes-to: #N`
for partial work that does not complete an issue. Required CI and CodeQL checks run for `epic/**`
targets. Trusted automation uses default-branch code, treats PR text as data, and advances the
eligible child and parent records to `In Progress`.

After the required checks pass, merge the focused child PR into the epic branch. Trusted
automation revalidates its base and native parent, then closes the direct child and converges
Project Status to `Done`. Failed or ambiguous validation keeps the child open. Reopen the child for
a correction and use another focused completing PR. No intermediate Project Status is used.

After every intended child closes, merge current `main` into the epic branch. Verify the complete
`main...epic` candidate. Open one final PR to `main` with `Closes #<epic>`. The maintainer owns
cumulative acceptance and the final merge. Clean the epic branch and worktree after final merge
and exact safety checks. Retain uncertain state for maintainer action.

## Develop locally

Development requires Node 24 or newer; release CI uses Node 24.

```sh
npm ci
npm run verify
npm run smoke
npm run smoke:macos        # matching Apple-silicon Mac
npm run smoke:capacity     # contracts + machine-dependent evidence
npm run performance:capacity  # controlled-machine quantitative gate
npm run dev
```

`npm ci` downloads Electron and rebuilds native dependencies for Electron's ABI. On headless
Linux, run Electron smoke tests under `xvfb-run`. Install the optional pre-push smoke hook with:

```sh
npm run hooks:install
```

`npm run smoke` runs the focused `pty-native` and `viewer-position` groups plus the transitional
`legacy-workflow` group in separate Electron processes with fresh project and user-data roots,
then reports a result for every scheduled group. Select one group locally with
`HVIR_SMOKE_SCENARIO=<name> npm run smoke`; the complete name set is `pty-native`,
`viewer-position`, `platform-contracts`, `terminal-presentation`, `legacy-workflow`, and
`capacity`. `npm run smoke:macos` runs the focused PTY, viewer, platform-contract, and terminal
presentation correctness groups. `npm run smoke:capacity` selects the capacity group: terminal
topology, presentation, delivery, exact input, cleanup, and recovery contracts remain blocking,
while CPU, latency, and working-set measurements are labeled evidence. CI invokes this command
separately on Linux and macOS. `npm run performance:capacity` runs the same contracts and samples
but enforces the quantitative budgets on a controlled machine. These commands use the same
aggregate launcher, so a failing group does not prevent reporting its scheduled siblings.

For a bounded local stress run, set `HVIR_SMOKE_REPEAT` to an integer from 1 through 100. For
example, `HVIR_SMOKE_SCENARIO=pty-native HVIR_SMOKE_REPEAT=20 npm run smoke` schedules 20
iterations of that group. Each iteration launches a fresh Electron process with fresh project and
user-data roots. Iterations are fixed stress evidence, not retries: every scheduled iteration runs,
and any failed iteration makes the aggregate command fail. Pull-request jobs omit the variable and
therefore run one iteration.

Packaged smoke is a distribution boundary, not a second product workflow. On a matching supported
host, build the platform tarball and launcher, then run `npm run smoke:packaged`. It installs the
exact versioned tarballs into a clean prefix and proves launcher selection, executable architecture,
application/worker/native-PTY loading, preview-protocol handling, and retained platform geometry.
Ordinary behavior remains in the unpackaged groups.

Use `npm run gauntlet` for the full release gate on a controlled machine; it includes
`performance:capacity`. Packaging and performance work has additional acceptance guidance in
[`docs/packaging.md`](docs/packaging.md) and
[`docs/phase8-performance-gauntlet.md`](docs/phase8-performance-gauntlet.md).

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
