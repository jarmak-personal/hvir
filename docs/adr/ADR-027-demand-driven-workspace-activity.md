# ADR-027: Demand-driven Git workspace activity

## Context

The workspace coordinator historically ran porcelain status for every present worktree every
five seconds. ADR-023 reused that cadence to resurface closed workspaces after bounded Git
activity. The command remained off the render thread and its output was bounded, but its effects
were not bounded.

Git status may invoke repository-configured clean filters when a tracked file is stat-dirty.
Such filters are not necessarily read-only. Git LFS, for example, copies the complete working
file through its temporary object path while hashing it. Suppressing Git's optional index locks
also prevents a content-clean file's refreshed stat data from being persisted, so the filter can
run again on every poll. A genuinely dirty filtered file remains eligible for filtering even
when index refresh is allowed. The child process's completed I/O may be accounted to hvir on
Linux, but that attribution is not the defect.

The activity snapshot must remain Git-owned, bounded, host-qualified, and useful for closed
workspace resurfacing. The fix must not disable repository filters, special-case Git LFS,
recursively scan worktrees, add a watcher per worktree, or reimplement porcelain status.

## Decision

Periodic project refresh continues bounded worktree discovery, but it does not sample status for
open workspaces. Open workspace activity is demand-driven by project opening, explicit refresh,
the existing active-workspace and Git-metadata watches, and successful or failed Git mutations.

Closed present workspaces retain periodic activity sampling while their latest comparable status
is clean or missing. The first dirty result remains eligible to resurface a clean-baseline closed
workspace under ADR-023. Once a workspace has a dirty result, the coordinator suspends identical
passive status requests. A full demand-driven refresh still samples it, and a discovery change to
HEAD or branch clears the suspension before the next closed-workspace sample. The suspension is
ephemeral coordinator state; no path, timestamp, file size, or new activity field is persisted.

The exact bounded porcelain command used only for workspace activity may take Git's optional
index lock and persist refreshed stat data. Main grants that authority through the existing Git
worker broker only for the exact validated status grammar. All other background Git reads retain
`GIT_OPTIONAL_LOCKS=0`, and all configured filters remain enabled.

Refresh generations distinguish current work from invalidated passive work. Project transitions
do not await an obsolete generation. Late completion remains rejected before registry activity
publication, while application disposal still settles all in-flight refreshes. Git mutation
coordination continues to drain even obsolete activity before switch, pull, or prune can acquire
repository locks.

This decision narrowly supersedes ADR-023's fixed per-worktree status cadence and ADR-008's
implication that periodic Git work refreshes every open workspace. ADR-023's bounded activity
schema, comparison rules, automatic clean-to-dirty resurfacing, and manual reopen path remain.

## Consequences

An idle open repository no longer invokes clean filters every five seconds. Content-clean files
can repair stale index stat data once, and a stable dirty filtered file does not create an
unbounded passive write loop. Worktree discovery, status parsing, and filter semantics remain
owned by system Git off the render thread.

A closed workspace with a clean baseline still resurfaces on the first comparable dirty status.
A closed workspace whose baseline is already dirty may require a later demand-driven refresh to
observe another status-only transition that leaves HEAD and branch unchanged. This is the
bounded cost of avoiding repeated content-filter execution without adding persistent metadata,
recursive scans, or hidden watchers. Manual reopen remains the reliable fallback.

Allowing the activity status to refresh the index can produce one small Git-metadata watch event.
The resulting demand refresh is bounded, and the refreshed stat cache prevents a content-clean
filter from recurring.

## Rejected alternatives

- Disable Git LFS or repository clean filters. That changes repository semantics and misses other
  effectful filters.
- Merely allow optional index locks while preserving five-second status polling. Stable dirty
  files still invoke their clean filter on every status.
- Poll at a slower fixed interval. Lower frequency still creates an unbounded write loop.
- Reconstruct status from plumbing commands or file metadata. That duplicates Git semantics and
  conflicts with the bounded porcelain activity contract.
- Add recursive scans, per-worktree watchers, or remote helpers. Those violate ADR-008 and
  ADR-023's resource and transport boundaries.
