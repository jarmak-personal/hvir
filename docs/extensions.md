# Extension packages

Open **Settings → Extensions → Open extensions folder**. Place one ready-to-run
package directory or ZIP there, then choose **Discover extensions**. Inspect its contract,
capabilities, and requested access before choosing **Enable** and **Open**. Discovery
reads data and executes no package code. Directories, ZIPs and development links share one validation and activation contract.
Duplicate package IDs are all refused; hvir never guesses which candidate you meant.

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
execute them. **Reload** accepts fresh directory or development bytes; **Replace**
accepts the selected ZIP revision. An explicit revision action revokes old guests before
admitting the next activation. Failed candidate validation keeps a valid current activation.
A source changed during discovery becomes inactive until an explicit revision action. Extension state lives separately in `extension-state/` beneath user data.
Do not edit that directory while hvir is running.

Only one instance per user-data directory can operate extensions. A second instance
can use ordinary workbench features but cannot change extension state or open guests.
The kernel-held writer lock releases on exit, including an abandoned process; hvir
never expires a live owner's lock. If its lock path changes, hvir revokes extension
work. For development, launch with `--user-data-dir=/absolute/separate-directory`
rather than sharing a release directory. SSH acceptance builds retain their separate
application-owned data root.

## ZIP, development, replacement and removal

To package the reference example, run `zip -r ../extension-reference.zip .` from inside
its directory, so `hvir-extension.json` is at ZIP root. Copy the completed archive into
the extensions folder and choose **Discover extensions → Enable → Open Extension reference**.
Do not leave the same package ID in both directory and ZIP forms. An incomplete copied ZIP
is rejected; finish the copy and discover again. ZIPs have at most 20 MiB compressed input,
16 MiB expanded assets, 256 materialized entries including implicit directories, 12 directory
levels, and ten seconds of decoding work. File sizes and CRCs are verified. Traversal,
absolute paths, links, encryption and conflicting portable destinations are refused. Preparation
runs no package scripts and serves only the captured validated revision.

For author development, create one top-level symbolic link in the extensions folder pointing
to the package directory. On Linux/macOS, `ln -s /absolute/author/package /absolute/user-data/extensions/development`
creates it. Settings labels it **Development package**. Edit the author directory and choose
**Reload**, then open the view again to see the change. A missing target is shown as missing;
restore the target or choose **Remove** to delete only the link. Interior links are refused.

To replace a ZIP, replace its source archive, discover it, and choose **Replace**. The manifest
ID retains the installation identity even when the source name or source kind changes. Current
contract 1.0 requests no access or connectors, so a valid explicit revision action needs no
additional permission decision. Unsupported broader access remains refused before execution;
package hashes are not executable approval.

**Remove** names the selected package and explains its file/data effects. An ordinary package
is moved to the OS trash. A development package loses only its link; author files remain.
Keep installation identity for reinstall, or select **Forget saved setup for this extension** to release
its saved platform package state. Libraries, project skills, issue databases and other domain
data are kept. Reappearing packages remain inactive until explicit Enable or Replace. An
unfinished removal remains visible and retryable across restart; cleanup failure cannot
restore authority. Ordinary removal requires recoverable OS trash.

Captured storage keeps at most three revisions per package, 96 revisions and 128 MiB globally.
Accepted/live revisions and the current preparation are protected under the same writer lease.
If protected bytes fill capacity, remove unused saved installation state before retrying.
Interrupted preparation is bounded and collected by the next writer. A failed collection of
an unused obsolete revision identifies its exact hash and repair instruction: close hvir,
move only that named `extension-state/packages/<hash>` directory outside the package store,
then restart and retry. Do not move accepted or live revisions. Uncertain changed files are
preserved, and unrelated accepted views remain usable.

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
for fixed Chromium `Page.setWebLifecycleState` active/frozen commands and native
`Page.documentOpened` observer-loss monitoring enabled by `Page.enable`. Engine
control is bounded and coalesced; loss, refusal, or timeout fails the view closed.
Initial captured-document bootstrap completes before freezing, while hidden refresh
and further-view requests remain denied. Document completion, trusted geometry
updates and native window show/restore/focus/resize events invalidate earlier
engine state. Chromium may also thaw an embedded guest when its native widget
becomes visible. The isolated preload observes trusted native visibility with a
captured engine getter, independently of Electron's public visibility mask; main
reapplies hidden intent only for that exact current guest. Reapplication is bounded
and coalesced without polling. Scheduled timers, one-shots and bridge deliveries
remain retained rather than discarded. A native invalidation can briefly run them
before the new freeze takes effect; hidden capability admission remains denied
throughout that transition. Sustained hidden execution remains suspended after
reapplication. The isolated window capture listener signals before package event
handlers, without deferring to guest-scheduled microtasks. Captured responses wait
for native monitoring before releasing package code. Replacing the main document
with `document.open()` or implicit document writing destroys isolated listeners;
this fails only the affected view closed, including an open without a later close.
Authors should update the existing DOM rather than replace its document. Ordinary
DOM changes remain supported. Native
DevTools target identity must resolve to that exact guest before each command.
No debugger API or remote debugging endpoint is exposed. This engine lifecycle
choice provides actual timer suspension independently of guest cooperation.
hvir owns reserved close shortcuts and guest disposal.

Packages have at most 256 entries, 12 nested directories, 2 MiB per file, 16 MiB total,
and a 32 KiB manifest. Interior links and nonregular assets are refused; the explicit top-level development link is resolved once per capture. Discovery admits at most
32 installations. Each extension has at most four views; the application has sixteen.
Messages are bounded to 16 KiB and thirty per second; pending requests are bounded to
eight per view, sixteen per extension, and sixty-four application-wide, with a ten
second deadline. hvir refuses excess work instead of maintaining unbounded queues.

The application registers the HTML preview and extension scheme descriptors together
once before Electron readiness. Their protocols, origins, policies and resources
remain feature-owned and independent.

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
