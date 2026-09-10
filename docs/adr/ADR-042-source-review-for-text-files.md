# ADR-042: Source review for workspace text files

> Lifecycle: Active
> Supersedes: [ADR-032](ADR-032-explicit-document-review-handoff.md) | partial | Markdown-only document, source-anchor, and batch scope; rendered capture remains Markdown-only.

## Context

Agent-authored code and configuration need the same explicit inline feedback and harness
handoff as Markdown. The existing review workflow anchors feedback to on-disk source lines,
which do not depend on a filename extension or a rendered representation.

## Decision

Allow source-line and line-range review on supported UTF-8 text files within the active
host-qualified workspace, regardless of extension. A batch may combine Markdown and other
text files in that same workspace. Rendered capture remains limited to Markdown's existing
source-line map; other rendered views, Git diffs, and historical snapshots gain no annotations.

The existing review owners and public seams remain authoritative. Preserve exact on-disk
anchors, unsaved-edit capture refusal, bounded reads, text validation, workspace confinement,
draft persistence and retention, revalidation, watch interests, revocation, and provider-safe
handoff. Binary, invalid UTF-8, and over-limit reads remain unavailable with visible reasons.
Local and SSH files use the same ProjectHost read and lifecycle contracts.

## Consequences

Users can review code, configuration, dotfiles, and extensionless text alongside Markdown
without expanding editing or introducing another annotation model. Extension alone cannot
establish text eligibility: capture still requires a complete validated on-disk read.

## Rejected alternatives

- An extension allowlist excludes valid text and duplicates file-format policy.
- Separate code-review state duplicates anchors, persistence, and delivery authority.
- General rendered or diff annotations need distinct location contracts and are outside this scope.
