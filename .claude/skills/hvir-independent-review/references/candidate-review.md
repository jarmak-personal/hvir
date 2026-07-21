# Candidate mode

Review the exact committed implementation candidate handed off by `hvir-implement-issue`.

## Preconditions

The lifecycle owner must provide all of this before reviewer processes start:

- an exact base commit and exact HEAD commit, captured after the final fetch and commit;
- proof that the base is the agreed PR/integration base and that the displayed range is the
  intended candidate;
- a worktree with no staged, tracked, or untracked changes (plainly disposable ignored build or
  dependency directories do not alter the candidate);
- a successful `npm run verify` after the last candidate change and before the exact HEAD commit;
  and
- the completing model family plus a trusted acceptance summary.

Do not review a branch name that may move. Put both full commit IDs in each prompt and tell the
reviewer to inspect only `<base-commit>...<head-commit>`. If the worktree changes, either commit
moves, or the intended base changes while review is running, discard both results.

## Candidate prompt additions

In addition to the common contract, tell each reviewer:

- `npm run verify` passed for this exact candidate. Do not run it or any other executable check.
- Begin with the exact diff, then read only the surrounding repository context needed to prove a
  finding. Do not review unrelated pre-existing code.
- Check the trusted acceptance summary against observable behavior in the diff.
- Trace important control and data paths across renderer, preload, main, workers, and
  `ProjectHost` only where the changed capability reaches those seams.
- Check correctness and failure behavior, security and authority boundaries, dependency
  direction and ownership, concurrency and stale async completion, resource lifetime and
  idempotent cleanup, local/SSH parity, responsiveness, and meaningful missing coverage.
- Check for duplicated policy, enlarged roots, generic helpers/services, speculative extension
  points, unnecessary dependencies or layers, and a complex solution where a narrower
  domain-owned change satisfies the same requirement.
- For a maintainability finding, identify the concrete ongoing cost, the requirement that would
  justify it, and the simpler ownership or design alternative.
- Cite changed lines whenever possible. A finding about unchanged context must explain how this
  candidate newly exposes or relies on the defect.

Locations use `path:line` in the HEAD tree. A clean result means the reviewer found no
blocker/high/medium defect in this exact range; it is not a general endorsement of the
repository.

## Lifecycle result

The completing agent evaluates both outputs. Any accepted correction returns to implementation,
focused checks, fresh `npm run verify`, a new commit, a newly captured exact range, and two fresh
reviewers. Record concise evidence for rejected false positives in the pull-request preparation
or maintainer handoff without storing full reviewer transcripts.

Only after two conforming results against the same exact range may `hvir-implement-issue` run the
required pre-push gate and push.
