# Phase 3 — Tabs & view modes

**Read first:** [`00-overview.md`](00-overview.md); design.md ADR-007 (per-tab view
mode — this phase implements it), ADR-005 (system git), §5 component map (HTML sandbox
security requirements).

## Goal

The viewing experience that *is* the product: VSCode-style tabs where every tab has a
three-state view mode — **rendered / source / diff** — with smart defaults, an
always-visible control, live-reload, and minor-edit-and-save. After this phase hvir is
a genuinely useful single-directory viewer.

## Tasks

### Tabs
- [ ] Tab strip over the viewer: open from tree (single-click preview-tab, double-click
      pinned — VSCode convention), close, reorder, dirty indicator.
- [ ] Per-tab state (view mode, scroll position) survives tab switches; open-tab set
      survives app restart.

### View modes (ADR-007)
- [ ] Per-tab mode: `rendered | source | diff`. Visible segmented control in the tab
      header + one keybinding cycling modes. Mode is sticky per tab.
- [ ] Default inference: markdown/mermaid/HTML/JSON open **rendered**; everything else
      **source**; files opened from a git context (Phase 5) open **diff**. Inference
      lives in one module with an obvious extension point per file type.
- [ ] **Rendered: markdown** — markdown-it + Shiki for fenced code. Mermaid blocks
      render as diagrams (verify current mermaid API; render off-thread or lazily).
- [ ] **Rendered: HTML** — sandboxed iframe, behaving like a browser opened the file.
      **Security requirements (non-negotiable, from §5):** `sandbox` attribute with no
      `allow-same-origin` escape to node, no node integration, strict CSP, block
      top-level navigation and window.open.
- [ ] **Rendered: JSON** — pretty-printed, collapsible tree.
- [ ] **Diff** — this file vs a base, with a small **base selector**: working tree vs
      HEAD vs branch-point (`git merge-base` with the default branch). Requires the
      minimal git slice below.

### Minimal git slice (single file only — full explorer is Phase 5)
- [ ] Git module in a utility process, shelling out to system `git` **through
      `ProjectHost.exec`** (ADR-005/010 — this makes Phase 4 remote git free):
      `show HEAD:<file>`, `merge-base`, repo-root discovery, single-file diff inputs.
- [ ] CodeMirror merge/diff view rendering the two versions.

### Live-reload & minor edit
- [ ] Open tabs subscribe to `ProjectHost.watch`: file changed externally → clean tab
      reloads in place (preserving scroll); dirty tab shows a conflict indicator, never
      silently clobbers either side.
- [ ] Minor edit + save: source mode is editable, `Ctrl+S` writes via
      `ProjectHost.writeFile`. **This is the guardrail (§2): no format-on-save, no
      multi-file operations, no LSP anything.**

## Acceptance criteria
- [ ] A markdown file opens rendered with highlighted code and a working mermaid
      diagram; one keystroke flips it to source; edit + save works; the rendered view
      updates.
- [ ] An HTML file renders like a browser page; its JS cannot reach node, navigate the
      app, or open windows (write a test page that tries).
- [ ] Diff mode shows a dirty file vs HEAD and vs branch-point via the base selector.
- [ ] `touch`/append to an open file from a terminal → tab live-reloads without focus
      change or scroll jump.
- [ ] All mode switches feel instant; rendering heavy files never stalls the UI.
- [ ] Status table updated.

## Non-goals
Multi-file diff lists, history, blame (Phase 5). Find/replace across files (open
question in §9 — default is no). Themes and side-by-side splits (Phase 8).
