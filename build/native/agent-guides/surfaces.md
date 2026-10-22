# Four contribution surfaces

Installed extension contract: 1.0. View declarations are ordinary package-local HTML. hvir owns placement, keyboard focus, close controls and reserved shortcuts.

The clock starts as an application-level viewer: {"id":"clock","title":"Clock","entry":"index.html","placement":"application","representations":["view"]}. It survives workspace selection independently. Add "navigation":"top" to make an application destination. This is a destination, not an inline top-bar widget. Change placement to workspace and add "navigation":"left" for a project/workspace explorer. Omit navigation for ordinary closable detail tabs.

Terminal-rail items declare id, placement (header/session), icon, tooltip, optional label, kind (control/observation) and click with view and placement (popup/viewer). For example: {"id":"pulse","placement":"header","icon":"◷","tooltip":"Current observation","label":"Waiting","kind":"observation","click":{"view":"clock","placement":"viewer"}}. The declared view must exist. See the executable updater example in `guide examples`.

A static item runs no guest. One separate updater supplies live values while a terminal item is visible even with no open popup. Items appear only in the full-size rail. Popups have bounded hvir-owned geometry, dismissal and focus return; popup focus does not clear terminal attention. context.read identifies exact live sessions; it contains no terminal transcript or PTY handle. Use explicit session IDs when publishing a session observation. Each package has at most 8 views, 8 items and 16 named actions within its 32 KiB manifest bound; application view capacity is 32.

Use `guide ui` for default controls, `guide lifetimes` for demand and `guide actions` for named view actions. All surfaces use the same public guest bridge and admission owners.

Placement and execution context are separate:

| Task | View and target | Connector context |
| --- | --- | --- |
| Show a clock anywhere | Application view; no workspace | None |
| Show local library data | Application view | Application; always local |
| Show data from a registered SSH project | Application top view; user selects that connected project/worktree in hvir's trusted target control | Workspace; exact admitted workspace and separately approved SSH host |

An application view receives no ambient project target. Use the context returned after trusted selection, not the desktop's current project. A workspace connector does not become application-local because its view is placed at the top. See `guide connectors` for configuration.

A header value is shared per installation/item. Session values use exact current session IDs and the updater's demanded sessions, not every workspace. There is no per-workspace header key. Put longer lists in your own popup/view; `viewer.open-own` below opens only this installation's declarations. Selectable text can present a URL or command, but there is no public URL-opening, clipboard, existing-PTY-input or workspace-management capability.

### viewer.open-own

Input: `{contributionId:'detail',input?,context?:'application'}`. Returns `{viewId}` for the hvir-owned tab. The contribution must exist in this package. Input is JSON bounded to 6144 encoded bytes; context:'application' applies only to an application contribution. Neither grants access or changes caller origin. Hidden ordinary requests and updaters cannot open further views; a current finite action must carry actionId as described in `guide bridge`.

### contributions.read

No input. Returns the installation's admitted presentation values as an array and enables `{kind:'contributions',values}` snapshots. Each value is `{item,session?,icon?,label?,tooltip?,availability?,observedAt?}`. Hidden subscriptions retain the current snapshot without queueing history and receive it on resume.

### contributions.publish

Input: `{item:'pulse',session?,icon?,label?,tooltip?,availability?,observedAt?}`. Returns `null` after successful validation/publication. Use an own declared item and, for a session value, the exact current session id. Omit session for an all-sessions value. Observations accept current/stale/disconnected/failed; current requires a finite timestamp. Controls cannot claim observation freshness. Icons are one or two plain Unicode glyphs (at most eight UTF-16 units); labels are at most 24 characters and tooltips 160. Invalid values, stale sessions, missing refresh demand or exceeded bounds refuse. Retained all-sessions controls persist; observations are in-memory and historical observations are stale, never mutation authority. Presentation is bounded to 16 KiB/installation and 256 KiB globally.

Read-only workspace.root metadata may be omitted to preserve the complete 7 KiB context bound. Treat absent roots and SSH installed presence as unknown; never infer local project discovery. Use `guide sources` for complete selected-document inputs, result paging, grants and reveal, and `guide bridge` for request correlation and context shape.
