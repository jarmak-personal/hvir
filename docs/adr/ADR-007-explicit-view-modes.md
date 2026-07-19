# ADR-007: Explicit rendered, source, and diff view modes

## Context

Different files and entry points have useful default representations, but invisible
automatic switching makes the viewer feel unpredictable. Rendering, source, and Git
comparison should be one understandable per-tab model.

## Decision

Every viewer tab has one visible, sticky mode: rendered, source, or diff. One workbench
keybinding cycles the modes and is ignored when the event originates in a terminal.
Markdown, Mermaid, and HTML default to rendered; Files-tree activation defaults by file
type; Git activation defaults to diff unless an untracked file has no meaningful base.

Diff mode exposes working tree, HEAD, and branch-point bases. Working tree compares Index
to the live file. Branch point compares merge-base to `HEAD`, intentionally excluding
uncommitted work so its badge and content answer the same question.

HTML preview documents use bounded in-memory responses through a dedicated
`hvir-preview:` protocol. Response-header CSP applies before document bytes, and the
iframe is sandboxed without same-origin, navigation, popup, or form authority. Preview
creation and release use typed, main-frame-only IPC.

## Consequences

Smart defaults remain visible and immediately overridable. A tab has one representation
state instead of separate preview panes or commands. HTML can run explicitly permitted
preview script without sharing the workbench's origin, nonce, filesystem, or IPC authority.

## Rejected alternatives

- Separate preview commands or panes.
- Fully automatic mode switching with no exposed control.
- Comparing the working file with itself rather than Index to working tree.
- Including uncommitted work in branch-point changes.
- `srcdoc`, static or shared nonces, `file:` URLs, or meta-only CSP for untrusted HTML.
