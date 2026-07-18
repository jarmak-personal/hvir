# ADR-005: System Git behind an off-thread engine

## Context

hvir must present truthful Git state for ordinary repositories, worktrees, remote hosts,
large histories, and branch topology without blocking Electron paint. Its view-first
scope permits only a few tightly bounded navigation mutations.

## Decision

Use the system `git` binary as the only Git engine. Command construction, bounded output,
parsing, cancellation, and repository validation run in a utility process behind the
stable `GitEngine` facade.

The worker does not own transport authority. Its narrow host proxy sends Git execution
and confined reads to main, where the registered `ProjectHost` is selected by host ID and
root. Main independently validates exact command grammars, roots, arguments, timeouts,
and output limits before dispatch. SSH clients and authentication remain main-owned.

The Git rail is the compact current-branch navigator. A project-scoped viewer tab owns
the virtualized all-reference commit graph and persistent commit inspector. Both use the
same deterministic local lane model; commit bodies use the existing sanitized,
off-thread Markdown renderer. The Files tree classifies ignored entries lazily in bounded
batches and reuses the Git changes snapshot for working-tree decorations instead of
performing Git work during directory reads.

The active workspace may switch only among existing local branches when Git and hvir are
clean and the branch is not checked out in another worktree. Remote synchronization is
limited to explicit fetch and clean, behind-only, fast-forward-only pull. These mutations
use single-use exact-root authorization, argv arrays rather than a shell, and disable
interactive prompting. Dirty, detached, diverged, authentication, and integration cases
are explained and handed to the terminal.

## Consequences

Git behavior matches the user's installed Git, including worktrees and host-specific
configuration. Parsing and history cost cannot delay renderer paint, while main retains
transport and mutation authority. Cached remote refs are identified as cached; failures
degrade the Git surface without breaking filesystem browsing. Product scope excludes a
general Git client.

## Rejected alternatives

- isomorphic-git, because worktree support and large-repository behavior are poor fits.
- libgit2 bindings, because native build complexity brings little value over system Git.
- Creating SSH clients in the worker or running parsing in main.
- Third-party graph widgets whose DOM, paging, keyboard, or policy models do not fit a
  virtual repository viewer.
- Unbounded ignore scans, one Git process per visible row, or incomplete results presented
  as complete.
- Branch creation/deletion, checkout of arbitrary commits, stage, commit, stash, merge,
  rebase, push, force, reset, autostash, conflict UI, or automatic pull.
