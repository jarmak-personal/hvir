# ADR-004: CodeMirror 6 and Shiki for the code viewer

## Context

hvir is a read-first workbench that must render source beautifully while supporting only
a bounded minor-edit-and-save path. A full IDE editor surface would add weight and invite
features outside the product boundary.

## Decision

Use CodeMirror 6 for the source and diff view surfaces and Shiki for TextMate-grammar,
VS Code-theme highlighting. Keep Monaco as a fallback only if the minor-edit path later
requires exact Monaco behavior.

## Consequences

The viewer stays composable and lighter than a full editor while retaining high-quality
highlighting. Tokenization and large reads must remain bounded and off the render thread.
The decision does not broaden hvir into an editor, LSP host, or debugger.

## Rejected alternatives

Using Monaco by default would import a larger editor-oriented surface before its exact
behaviors are needed. A custom viewer would rebuild mature selection, scrolling, syntax,
and accessibility machinery.
