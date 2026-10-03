# Four contribution surfaces

Installed extension contract: 1.0. View declarations are ordinary package-local HTML. hvir owns placement, keyboard focus, close controls and reserved shortcuts.

The clock starts as an application-level viewer: {"id":"clock","title":"Clock","entry":"index.html","placement":"application","representations":["view"]}. It survives workspace selection independently. Add "navigation":"top" to make an application destination. This is a destination, not an inline top-bar widget. Change placement to workspace and add "navigation":"left" for a project/workspace explorer. Omit navigation for ordinary closable detail tabs.

Terminal-rail items declare id, placement (header/session), icon, tooltip, optional label, kind (control/observation) and click with view and placement (popup/viewer). For example: {"id":"pulse","placement":"header","icon":"◷","tooltip":"Current observation","label":"Waiting","kind":"observation","click":{"view":"clock","placement":"viewer"}}. The declared view must exist. See the executable updater example in `guide examples`.

A static item runs no guest. One separate updater supplies live values while a terminal item is visible even with no open popup. Items appear only in the full-size rail. Popups have bounded hvir-owned geometry, dismissal and focus return; popup focus does not clear terminal attention. context.read identifies exact live sessions; it contains no terminal transcript or PTY handle. Use explicit session IDs when publishing a session observation. Each package has at most8views,8items,8actions; application view capacity is32.

Use `guide ui` for default controls, `guide lifetimes` for demand and `guide actions` for named view actions. All surfaces use the same public guest bridge and admission owners.

Own contributions may receive JSON input bounded to 6144 encoded bytes through viewer.open-own. Optional context:"application" applies only to an application contribution; neither input nor root metadata grants access or changes caller origin. Read-only workspace.root metadata may be omitted to preserve the complete 7KiB context bound. Treat absent roots and SSH installed presence as unknown; never infer local project discovery. Selected human views can read granted current documents with source.select/read and confined source.asset images. Each source receipt expires after five minutes, including idle views; only nextOffset:null completes a paged read. See the maintained extension manual for exact source bounds.
