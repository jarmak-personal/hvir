# Directory extensions

Open **Settings → Extensions → Open extensions folder**. Place one ready-to-run
package directory there, then choose **Discover extensions**. Inspect its contract,
capabilities, and requested access before choosing **Enable** and **Open**. Discovery
reads data and executes no package code. This first slice supports directory packages;
ZIPs, development links, Reload, Replace, and removal follow in package management.

The ready-to-run example is `packages/extension-reference` in a checkout. Installed
macOS packages include it at `/Applications/hvir.app/Contents/Resources/extension-reference`;
Linux packages include it beneath the application resources directory as `extension-reference`.
Copy that entire directory
into the extensions folder; it needs no build, project grant, or configured executable.
Choose **Open Extension reference**, then use its **Open reference detail** button.
Close tabs through hvir's tab or view controls. Disable in Settings closes all its views.
Application-level tabs stay available when you switch workspaces and gain no project
access. A crashed view remains independently closable and can be opened again.

hvir captures an enabled package in its content-addressed store. Running views serve
the accepted bytes, not mutable source files. Discovering external edits does not
execute them. Disable and enable after inspecting the discovered revision to accept
those bytes. Extension state lives separately in `extension-state/` beneath user data.
Do not edit that directory while hvir is running.

Only one instance per user-data directory can operate extensions. A second instance
can use ordinary workbench features but cannot change extension state or open guests.
The kernel-held writer lock releases on exit, including an abandoned process; hvir
never expires a live owner's lock. If its lock path changes, hvir revokes extension
work. For development, launch with `--hvir-user-data-dir=/absolute/separate-directory`
(see the application's runtime options) rather than sharing a release directory.

## Package contract

The package contains `hvir-extension.json`, HTML entries, and ready-to-run relative
assets. The example manifest shows all required fields. Identity and contribution IDs
are stable lowercase names. `contract` declares a major and minor, independently of
the package's semantic `version`. This slice offers application placement and a single
`view` representation. `access` is empty: no project files, PTYs, executables, or network.

Contract 1.0 provides `presentation.read` and `viewer.open-own`. List required and
optional capabilities explicitly. Same-major older or equal minor contracts activate;
a newer minor also activates when every required capability exists. Unsupported major
or missing required capabilities refuse only that package, with an explanation.
Unknown fields produce bounded warnings and grant no authority. If a new safety
meaning is required, require its named capability rather than an ignorable field.

Each guest gets only `window.hvirExtension.send(message)` and
`window.hvirExtension.onMessage(callback)`, which returns an unsubscribe function.
First send `{ kind: 'hello', contract: '1.0' }`. hvir replies with `kind: 'hello'`,
its supported contract, admitted capabilities, presentation, and validation warnings.
Check the returned capabilities before sending a request. Requests use a bounded
unique `id`, a `capability`, and optional `input`. Results retain that `id`, contain
`ok`, and return either `value` or `error` plus warnings. Send `{ kind: 'cancel', id }`
to cancel pending work. Revocation rejects late completion; canceled work publishes no
new authority.

`presentation.read` returns appearance, semantic colors (`background`, `surface`,
`text`, `muted`, `accent`), interface font and pixel size, and available width/height.
`kind: 'presentation'` updates these values when appearance or geometry changes.
`viewer.open-own` takes `{ contributionId: 'detail' }` and opens only the caller's
declared contribution. hvir selects and identifies the tab. Guest identity, approval,
host, or URL fields cannot manufacture permission. Hidden views cannot request refresh
or open further views. Inactive guests are frozen by Chromium and resume on selection;
hvir retains their latest presentation rather than queueing hidden updates. CSS hiding
and `document.visibilityState` do not reliably reflect Electron webview inactivity.
The private main-owned surface uses Electron's [debugger transport](https://github.com/electron/electron/blob/v43.5.0/docs/api/debugger.md)
solely for fixed Chromium `Page.setWebLifecycleState` active/frozen commands. Engine
control is bounded and coalesced; loss, refusal, or timeout fails the view closed.
Initial captured-document bootstrap completes before freezing, while hidden refresh
and further-view requests remain denied. Document completion, trusted geometry
updates and native window show/restore/focus/resize events invalidate earlier
engine state; the surface reapplies the latest target without polling. Native
DevTools target identity must resolve to that exact guest before each command.
No debugger API or remote debugging endpoint is exposed. This engine lifecycle
choice provides actual timer suspension independently of guest cooperation.
hvir owns reserved close shortcuts and guest disposal.

Packages have at most 256 entries, 12 nested directories, 2 MiB per file, 16 MiB total,
and a 32 KiB manifest. Links and nonregular files are refused. Discovery admits at most
32 installations. Each extension has at most four views; the application has sixteen.
Messages are bounded to 16 KiB and thirty per second; pending requests are bounded to
eight per view, sixteen per extension, and sixty-four application-wide, with a ten
second deadline. hvir refuses excess work instead of maintaining unbounded queues.

Guests use separate ephemeral sessions, an hvir-owned preload, response-header CSP,
and captured assets only. The response `Connection-Allowlist: (response-origin);webrtc=block`
uses Chromium's browser-side `ConnectionAllowlists` and
`OverrideConnectionAllowlistOriginTrial` features, enabled before app readiness.
[Chromium 150's feature definition](https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/third_party/blink/renderer/platform/runtime_enabled_features.json5)
requires the browser override; a Blink flag or constructor deletion alone provides no
transport guarantee. Node, Electron, workbench IPC, other packages, direct network
(including WebRTC), frames, workers, downloads, popups, and browser permissions are
unavailable. A guest failure cannot veto trusted close or disable controls.

## Local implementation evidence

The private local storage edge uses Node-API and POSIX `flock`/`openat`. A heartbeat
lock cannot prove that a stalled live owner is abandoned; ordinary path-based reads
cannot prove containment while an ancestor is replaced. The mature [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) heartbeat model cannot distinguish a stalled live owner;
[`fs-ext`](https://github.com/baudehlo/node-fs-ext) offers `flock` through an Electron ABI rebuild but does not offer pinned
`openat` traversal. Neither provides the combined lifetime and containment guarantee. Node's `/dev/fd` path traversal is not portable to
macOS. The small maintained edge supplies only local storage mechanics; validation,
limits, revision identity, and grants remain TypeScript-owned. It is not a guest API
and does not add remote package authority. Normal builds include its exact native
payload. Real Electron coverage proves the environment boundary in addition to direct
policy, storage, and lifecycle tests.
