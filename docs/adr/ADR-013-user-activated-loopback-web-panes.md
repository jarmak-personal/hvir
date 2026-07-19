# ADR-013: User-activated loopback web panes over ProjectHost routes

## Context

Live local web applications are valuable agent output, especially when tied to the exact
host, workspace, and terminal that produced them. A normal browser lacks that provenance;
a dashboard, server manager, or general embedded browser would exceed hvir's view-first
scope and introduce broad process, filesystem, and network authority.

## Decision

### Activation and identity

A user may activate an ordinary HTTP loopback link printed in a terminal to open a
transient web pane in that terminal's host-qualified workspace. hvir never infers or runs
the server command, probes ports, owns the process, or stops it when the pane closes.
`TerminalPane` recognizes loopback links before file parsing and emits typed provenance:
terminal ID, renderer owner, project root, and workspace root. Generic `window.open`, guest
navigation, scripts, and redirects are not activation sources.

Accepted v1 links are `http://` loopback names and addresses with a valid explicit port.
Unspecified bind addresses are visibly normalized to `localhost`; URL credentials are
rejected. HTTPS requires a separate certificate/trust decision. WebSockets are allowed only
as traffic ancillary to an authorized HTTP pane.

One pane is reused per host-qualified workspace and canonical loopback origin. It is an
ordinary viewer pseudo-tab with bounded title, pinned origin, editable path/query/fragment,
back/forward/reload, transient full-page, and explicit external-browser controls. A server
moving ports creates/selects a different origin pane; hvir never silently retargets
authority or browser state.

### Ownership and routing

Pane lifetime follows workspace ownership rather than current visibility. Project/workspace
navigation hides without destroying the guest or route. Explicit pane close, workspace
dismissal, project close, renderer reload/destruction, or app quit revokes it. SSH
disconnect kills unusable streams but retains a visible disconnected pane; explicit reload
after reconnect creates a fresh route. Pane state, routes, history, and sessions are not
persisted across app relaunch. Capacity is bounded and never silently evicts a pane.

For SSH workspaces the application-visible origin remains the remote service's loopback URL.
Main creates a unique in-memory Electron session and a hvir-owned authenticated loopback
proxy that carries bounded TCP streams through the pane's `ProjectHost`. `SshHost` uses SSH
direct forwarding; `LocalHost` uses an identity route. hvir does not rewrite HTML,
JavaScript, bodies, headers, cookies, redirects, or application URLs.

Each pane proxy has high-entropy memory-only credentials known only to main. Credentials
are supplied only for an exact proxy-auth challenge bound to the live guest and route,
validated on every request or tunnel, stripped before forwarding, and destroyed with the
pane. The proxy authorizes only explicitly activated endpoints and cannot fall through to a
same-port service on the user's local machine. A hvir-owned affordance may explicitly add a
different loopback endpoint while retaining the original provenance and normal browser
CORS rules. Public internet subresources use normal browser networking.

Per-pane sessions intentionally isolate cookies and storage from hvir and other panes.
Different ports in one pane session may share host cookies as browsers normally do, but
separately opened panes do not share their sessions. `localhost` and loopback IP spellings
remain distinct origins and pane identities.

### Navigation and hostile content

Same-origin navigation remains in-pane. Different-loopback top-level navigation is blocked
and may offer a hvir-owned action to open/select an authorized pane on the same
`ProjectHost`. External HTTP(S) navigation is blocked and may offer an explicit trusted
Open in browser action; other schemes have no external action. Guest content never opens
the system browser automatically. A remote pane's external-browser compatibility path may
create a bounded conventional local forward, visibly changing the browser origin.

React depends on a narrow `WebPaneSurface`, not directly on Electron `<webview>`. Main
permits one attachment only when sender, opaque pane ID, initial URL, partition, and unused
slot match a live route record, then binds the exact guest atomically. Node integration and
renderer integration are off; context isolation, sandbox, and web security are on; there is
no guest preload, hvir IPC, DevTools, persistent partition, permission grant, download, or
popup authority. Text input, forms, and bounded in-page dialogs remain usable, while
`beforeunload` cannot veto hvir lifecycle. Reserved hvir shortcuts are intercepted before
guest dispatch.

### Diagnostics and authority

A pane retains source-terminal provenance and offers Back to terminal plus bounded recent
navigation/tunnel failures, failed requests, console warnings/errors, and crash diagnostics.
It records no bodies, cookies, headers, form values, DOM contents, or ambient browsing.
Credential-bearing URL parts are removed; query/fragment values are omitted from exports by
default; potentially sensitive console text is previewed before copy. Copy report and Reveal
source terminal are the baseline actions. Any future direct provider delivery must be an
explicit provider capability routed through exact PTY ownership, never a generic PTY write.

Main owns a route registry qualified by renderer owner/generation, pane ID, source terminal,
host-qualified workspace, and authorized endpoint set. Creation requires exact live
provenance; ordinary workspace selection does not expand authority. Revocation and every
late callback carry generations and fail closed. Network bytes never cross renderer IPC;
main streams with backpressure, bounded handshakes, timeouts, and admission limits. SSH web
routes use auxiliary capacity and cannot borrow reserved control or terminal transports.

## Consequences

hvir can view live agent output beside its source code and conversation while preserving
remote origin behavior, workspace provenance, responsiveness, and explicit authority.
Embedding hostile content increases Electron lifecycle and security responsibility, which
is contained behind `WebPaneSurface`, main-owned sessions, authenticated routes, and
`ProjectHost`. Page failure remains pane-scoped; host loss also appears in the project
connection surface.

## Rejected alternatives

- Persisted dashboards, server registries, hvir task runners, port discovery, or server
  lifecycle management.
- Global `window.open` authorization, iframe embedding, or exposing Electron webview details
  throughout React.
- Rewriting remote origins, HTML, or headers; installing a remote proxy; or sharing a
  persistent guest partition.
- Unauthenticated proxies, broad local/remote network authority, silent local fallthrough,
  URL-credential stripping, or alias merging.
- General browsing, guest popups, automatic external opens, downloads, DevTools, device
  emulation, extensions, or unrestricted permissions.
- Persisting/restoring panes, killing them on ordinary navigation, silently evicting them,
  or allowing unbounded guests, streams, channels, and diagnostics.
- Automatically injecting page failures into an agent terminal.
