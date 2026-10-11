# Extension packages

The [0.3 setup guide](extension-setup.md) covers the downloadable Skillager ZIP, installed
authoring and ordinary agent access. The release ZIP is independent of the native app installer.

Choose **Settings → Extensions → Add extension…**. On macOS, select one ready-to-run
ZIP or package directory. On Linux, select a ZIP or the exact `hvir-extension.json` inside
its package directory; hvir copies that whole directory. The native picker identifies the
package form automatically. Other JSON files are refused with this selection instruction.

hvir validates and copies the selection into this instance's extensions folder, then shows
it immediately, accepting and enabling that exact validated copy. The original is preserved;
directories are copied, never linked. A package's optional `landing` names an ordinary
application view in its own manifest. After its first-use program connection settles,
that declared destination opens directly while the installation intent remains current.
Without a declaration, choose **Open** to view it. Leaving the Add flow prevents late
navigation. Unrelated unsaved app preferences remain in Settings for your next visit;
explicit Close and Save retain their normal behavior. Capture and validation
execute no package code. Installation grants no native program, file-root or agent access;
review and approve needed access separately. Passive discovery remains nonactivating.
Canceling the native picker imports nothing. An interrupted import reports its outcome;
do not assume an already submitted publication was rolled back. Once installation commits,
leaving or canceling setup preserves the installed extension and prevents late landing navigation.
An invalid or changing source is refused before publication. Filename or present package-ID
conflicts preserve the existing installation; Remove explicitly before adding a replacement.
An explicit reinstall through Add enables its validated revision and can reuse unchanged kept setup.

**Author and discovery controls** contains **Open extensions folder** and **Discover
extensions** for manual copies and explicit development links. Directories, ZIPs and
links share one validation and activation contract. Duplicate IDs are all refused; hvir
never guesses which candidate you meant.

The ready-to-run example is `packages/extension-reference` in a checkout. Installed
macOS packages include it at `/Applications/hvir.app/Contents/Resources/extension-reference`;
Linux packages include it beneath the application resources directory as `extension-reference`.
Use **Add extension…** to select that directory (its manifest on Linux); it needs no build, project grant, or configured executable. On macOS, press **⇧⌘G** (Go to Folder) in the picker, enter
`/Applications/hvir.app/Contents/Resources/extension-reference`, then select the directory.
If hvir is installed elsewhere, use that application’s matching `Contents/Resources/extension-reference` path.
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
its directory, so `hvir-extension.json` is at ZIP root. Choose **Add extension…**, select the completed archive, then **Open Extension reference**.
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
ID retains the installation identity even when the source name or source kind changes. An explicit revision action reuses native approval only when the connector declaration, host, canonical executable path and configuration remain unchanged. Changed access requires a separate native decision; package hashes are not executable approval.

**Remove** names the selected package and explains its file/data effects. An ordinary package
is moved to the OS trash. A development package loses only its link; author files remain.
Keep installation identity for reinstall, or select **Forget saved setup for this extension** to release
its saved platform package state. Libraries, project skills, issue databases and other domain
data are kept. Reappearing packages remain inactive until explicit Enable or Replace. An
unfinished removal remains visible and retryable across restart; cleanup failure cannot
restore authority. Ordinary removal requires recoverable OS trash. Trash receives a visible
`remove-UUID` directory or `remove-UUID.zip` archive. After **Put Back** or recovery from
Trash, choose **Discover extensions**, then explicitly **Enable**. The recovered source
name changes; its manifest ID still identifies the same saved setup.

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
the package's semantic `version`. Views declare `application` or `workspace` placement and a single
`view` representation. Optional `navigation: 'top'` creates an independent application
destination; `navigation: 'left'` creates a workspace rail view. `access` declares at most four scoped sources, or is empty. Read-only sources and the explicit delivery modes below confer separate authority. Source roots require separate trusted grants; no ambient project files, PTYs or direct guest network are exposed. Optional `connectors` declare finite native operations and require separate approval.

Contract 1.0 provides `presentation.read`, `viewer.open-own`, `context.read`,
`contributions.read`, `contributions.publish`, `actions.invoke`, `connector.status`,
`connector.execute`, `connector.output`, `connector.connect`, `terminal.start`, `source.status`, `source.request`, `source.select`,
`source.read`, `source.asset`, `source.render`, `source.reveal`, `delivery.capture`, `delivery.manifest`, `delivery.preview`, `delivery.apply`, `delivery.status`, `delivery.domain`, `delivery.reconcile`, and `delivery.cleanup`. List required and
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

`presentation.read` returns appearance, the closed semantic CSS color vocabulary,
interface and monospace font stacks, interface scale, and available
width/height. `kind: 'presentation'` updates these values when theme, typography, or
geometry changes. Colors are resolved bounded browser color values; they convey no
host authority. The workbench keeps theme and typography preferences in Settings.

`viewer.open-own` takes `{ contributionId: 'detail' }` and opens only the caller's
declared contribution. hvir selects and identifies the tab. Guest identity, approval,
host, or URL fields cannot manufacture permission. Hidden views cannot request refresh
or open further views without the provenance of a current finite invocation. Inactive guests are frozen by Chromium and resume on selection;
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

### Optional offline UI kit

The reference package includes `presentation.css`, `tokens.css`, `primitives.css`, and
`guest-ui.js`. Copy these ready-to-use files into a package, link `presentation.css`,
and load `guest-ui.js` before the consumer script. They require no framework, build,
network, or font service. Repository maintainers refresh package copies with
`npm run extension:ui -- /absolute/package-directory`; authors can use the shipped
copies directly. Copying does not modify the shared source tree. Contributors regenerate
`tokens.css` separately with `npm run extension:ui:tokens` after canonical token edits.
Activation captures their exact bytes with the rest of the package.

Use `hvir-guest` on the body and call
`const dispose = window.hvirUI.bindPresentation(window.hvirExtension)` once.
Call `dispose()` on page teardown or revocation. The binding owns one public-bridge
subscription and ignores late messages after disposal. The reference consumes the same
shared controls, fields, rows, panels, metadata, status, focus, and scrolling rules as
the built-in UI. Feature layout stays with the consumer.

The supported examples are a searchable list/detail view and a simple clock. Use a
labeled `hvir-field`, `hvir-list-detail`, a labeled listbox, and direct child buttons
with `role="option"`, `hvir-row hvir-button hvir-focus`, and
`data-variant="selectable"`. `window.hvirUI.bindList(list, onSelect)` owns ordinary
click and Arrow/Home/End handlers; call `refresh()` after replacing rows and
`dispose()` before releasing the view. It skips disabled and hidden rows and never
sends host requests. A clock can use `hvir-panel`, `hvir-content`, and `hvir-meta`
with the existing visibility/timer lifecycle described above.

Controls use ordinary guest DOM events. Host actions explicitly use the existing
public bridge. These classes cannot grant access, place or activate views, show trusted
permission surfaces, run native tools, or read files. Custom guest HTML can continue
using the public presentation contract without this optional kit.

Packages have at most 256 entries, 12 nested directories, 2 MiB per file, 16 MiB total,
and a 32 KiB manifest. Interior links and nonregular assets are refused; the explicit top-level development link is resolved once per capture. Discovery admits at most
32 installations. Each extension has at most eight views; the application has thirty-two (including updaters).
Messages are bounded to 16 KiB and thirty per second; pending requests are bounded to
eight per view, sixteen per extension, and sixty-four application-wide, with a ten
second ordinary deadline. Finite actions and connectors use their separately bounded lifetimes. hvir refuses excess work instead of maintaining unbounded queues.

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

## Rails, observations and named actions

The reference package contributes **Reference workspace** in the project rail and
**Reference library** beside **Sessions**. hvir owns their navigation, sizing and close
controls. Selecting a built-in view hides its retained guest; closing it destroys the
guest. Application destinations need no workspace or project grant and remain independent
of workspace selection. A removed contribution returns to the built-in destination.

An optional `navigationIcon` on a top/left view names a package-relative `.svg`. It is
pure decoration: the title, keyboard focus and selected destination remain unchanged. Only the
accepted captured revision supplies its image; editing source requires explicit Reload/Replace.
Missing, invalid or unsupported icons warn in Settings and fall back to text navigation.
The passive vocabulary is at most 8 KiB of UTF-8, one explicit finite `viewBox`, and up to sixteen
self-closing paths. Paths use explicit `M/m`, `L/l`, `H/h`, `V/v` and `Z/z` commands (at most
1024 characters/256 tokens per path; coordinates and view-box values within 4096). Paint is
`none` or `currentColor`, with optional stroke width 0.1–4, standard line caps and joins.
Use simple visible geometry. Scripts, handlers, styles, entities, links, external resources,
other XML/markup and complex SVG commands are unsupported. hvir reconstructs a passive image
mask without inserting package SVG markup into its workbench. Disable, replacement and removal
retire it with the ordinary contribution snapshot; no background guest or updater is allocated.

`railItems` declare `header` or `session` placement, `control` or `observation` kind,
`icon`, `tooltip`, optional `label`, and `click: { view, placement: 'popup' | 'viewer' }`.
Icons are one or two plain Unicode glyphs, at most eight UTF-16 units; labels are at most
24 characters and tooltips 160. Each package has at most eight items. Static items require
no guest and appear only in a full, visible terminal rail. Popups have hvir-owned bounds,
outside dismissal, Escape (including from focused guest content), close controls and
focus return. Their focus does not select a terminal or clear its attention.

For the reference walkthrough, explicitly launch an ordinary **Shell** using the terminal
rail. No Sessions destination or harness observer is needed. Click the row's diamond,
then **Mark this session**: its label and icon change for that exact live session. Close
the popup; the header observation continues updating. A session value ends when its
instance, renderer owner or workspace context ends, including a move. Selection cannot
retarget an existing popup or action. Old session IDs are refused.

An optional `updater` names a captured HTML entry. At most one isolated updater serves
an active installation across its visible contributions and windows. Visible header/row
items create demand without a popup. A visible ordinary viewer also creates demand when
the terminal rail is compact or collapsed. Settings-obscured guests supply no refresh demand,
while their finite admitted actions can finish. Compact, collapsed, hidden and background surfaces
provide no demand. No demand freezes native execution and refuses refresh; resumed demand
supplies current context before work resumes. The reference timer demonstrates this with
**Live N**. A stopped updater leaves a visible failed observation; use **Disable → Enable**
or **Reload** to restart it. Updaters cannot open views or invoke actions.

`context.read` admits opaque workspace IDs, names and host identities, and exact live
session IDs/titles when the owning surface has that context. Independent application
content receives no automatic workspace/session context. The shared updater receives
only the aggregate of current admitted visible demand. Context holds at most 128 sessions
within 7 KiB; it contains no paths, PTY handles, terminal content or controls. hvir sends
`{ kind: 'context', context }` on relevant changes. Surface and visibility descriptors
are ordinary presentation; undeclared context capabilities receive no privileged metadata.

`contributions.read` returns the installation's admitted presentation values and enables
`{ kind: 'contributions', values }` updates. Hidden subscriptions retain current data
without queueing events and receive the latest snapshot on resume. `contributions.publish`
takes `{ item, session?, icon?, label?, tooltip?, availability?, observedAt? }`. Omit `session`
for an all-sessions value. Observations declare `current`, `stale`, `disconnected` or `failed`;
`current` requires a timestamp. Controls cannot claim observation freshness. All-sessions
control presentation persists under the extension state writer. Observations remain in memory;
restored historical observations are stale. Presentation is bounded to 16 KiB per installation
and 256 KiB globally including live session values. Invalid saved presentation is discarded
without preventing other extensions from starting or setup from being forgotten.
**Forget saved setup** removes only this platform-owned presentation and identity; keeping
setup preserves them through reinstall. Queued writes cannot restore forgotten identities.

`actions` declare `id`, `title`, a named `view`, whether `agents` may call it, and
`effects: { delete: boolean, replace: boolean }`. These declarations grant no host access
or trusted decision. Each package has at most eight actions. A finite invocation opens its
ordinary closable viewer without taking keyboard focus. Hiding stops refresh while the
admitted invocation continues; close, context revocation, Disable or replacement cancels it.
An invocation originating in a visible guest retains that caller's selected view; its separate
action-origin handler remains closable and runnable in the existing viewer stack. An already
submitted `actions.invoke` result can finish through hiding, while hidden new requests and
ordinary body reads remain refused.
Settings offers **Run Describe session** with an application or exact live-session target,
including when no rail view is open. The reference action returns the admitted session and
caller. Its optional `delayMs` input is bounded to 500–5000 ms for observing hide/close behavior.

The public `actions.invoke` request takes `{ action, input? }` and returns its bounded result.
hvir sends the target guest `{ kind: 'action', invocation }`; reply with
`{ kind: 'action-result', id: invocation.id, value }` or an `error`. A hidden handler includes
`actionId: invocation.id` on hvir-mediated capability requests. hvir retains the originating
caller, authorization and context through those requests and any child invocation; expired
provenance grants nothing. Invocation IDs are delivered once to their negotiated guest,
and late results cannot settle newer or sibling work. At most four invocations run per
extension and sixteen globally. Inputs/results are at most 8 KiB. A deadline starts before
opening: 120 seconds by default, or declared `timeoutMs` from 1000 through 180000. Later
agent authorization consumes this same main-owned seam.

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

## Approved finite native connectors

An optional `connectors` array declares at most eight installed-tool connectors:

```json
{
  "id": "installed-tool",
  "description": "Read information from my installed tool",
  "context": "application",
  "timeoutMs": 180000,
  "outputBytes": 4194304,
  "environment": []
}
```

Declare `connector.execute`, `connector.output` and `connector.status` in required or optional
capabilities and check the guest handshake. Optional native capabilities leave unrelated views
usable when the executable is unapproved or disconnected. Discovery and status read metadata;
no executable probes run. hvir installs neither a tool nor a remote service.

In **Settings → Extensions**, enable the package, choose its configured host and an absolute
installed executable path, and enter configuration as `{ "args": [], "env": {} }`. The argument
prefix precedes each request's structured arguments. Environment overrides use only names declared
by the connector; the selected host account's ordinary environment is inherited. An SSH command
never receives a copied local environment. **Inspect native access** resolves the canonical path
without executing the tool. Inspect the declaration, host, canonical path and configuration,
then choose **Approve native execution**. Inspection of a configured SSH host may ask for its
ordinary SSH connection/authentication. Guest discovery and status cannot cause those prompts.
Use **Revoke native access** to stop new admissions and revoke pending requests and output pages.

Native code runs with the selected host account's authority, including its files, credentials,
network and subprocesses. A working directory, action title, or claimed read-only effect is not
confinement. UI enablement does not approve native execution. Manual executable selection uses an absolute path. An application or workspace connector may also
supply `setup: { executable: 'tool-name' }`, a simple basename (at most four hints per package).
After an explicit Add commits, hvir can passively inspect bounded local PATH/conventional-bin
metadata and present one **Connect** decision for the exact canonical programs and default
`{ args: [], env: {} }` configuration. No program, shell or version probe executes before consent.
Aliases to the same canonical executable are deduplicated. If an automatic Add finds no program,
it leaves installation successful and offers Connect as a later step. Explicit Connect can use a
native file selection for a missing or ambiguous program; hvir installs no dependency. Automatic
connection after Add considers application connectors only. Manual path/configuration controls
remain available; Settings keeps workspace configuration open because it has no admitted project
target for passive Connect.
Declining or canceling connection leaves the accepted extension installed and enabled.
Each approved binding saves separately; an interrupted save can have committed and must be checked
before retrying. Canceling a setup proposal retires only its prepared tokens.

A package may negotiate `connector.connect` and send `{ connector: 'tool-id' }` from a visible
ordinary human view to propose the same decision. Agent, updater, action-origin and admitted-action
requests cannot prompt or grant this access. Hiding/closing the view, leaving its trusted Settings
flow, native backgrounding, activation change or writer loss retires pending setup. The connection
decision uses the existing 60-second prepared-approval lifetime; late native replies do nothing.
No new file, project, delivery or agent authority is granted. A symlink binds its canonical target: changing the target
requires another decision. Updating the tool in place at the same canonical path requires no
new approval. hvir never hashes interpreted-tool contents. Explicit Reload or Replace reuses an
unchanged declaration/path/configuration binding and pins every execution to the new activation.
Forget saved setup removes native grants and platform identity while preserving tool/domain data.

For a declared workspace connector with a setup hint, that same explicit `{ connector: 'tool-id' }`
request uses only the current ordinary human view's main-admitted registered local project.
The guest cannot supply a host, workspace ID or replacement root. Main pins the registration and
host-qualified root through discovery, selection, consent and saving; a project/worktree switch,
closure, hide, cancellation or revocation retires the request. An SSH project cannot use this
flow to discover, authenticate or approve a replacement program. Existing explicit SSH Settings
setup is unchanged. Valid unchanged approval of that exact connector and local host needs no new
decision; another connector's approval never supplies permission, even for the same executable.
A connector retains one saved host binding. Connecting locally when it has a saved SSH binding
names that exact replaced host in the same trusted decision; accepting replaces that binding,
and its SSH projects need new approval. Declining preserves it. Saving refuses a changed prior
binding rather than applying stale replacement consent.
Native workspace approval remains host-scoped rather than folder-confined; each command still
requires its own admitted project context. No install-time workspace connection or project
mutation is introduced. File reading, agent access and delivery require their independent grants.

`application` connectors run locally in hvir's scratch directory without registering a project,
regardless of the selected workspace's host. `workspace` connectors require an explicit live
workspace ID and separate native approval on that workspace's host. Their working directory is
the pinned host-qualified workspace root. A grant on local conveys no SSH grant, and disconnect
never retargets or automatically replays a command. `connector.status` returns per-connector
`supported`, `unavailable` or `disconnected` availability and an achievable setup explanation.

Send `connector.execute` with `{ connector: 'installed-tool', host: 'local', args: ['--version'] }` for an
application connector. The requested host must exactly match its approval; forged or different hosts are refused before execution. For a workspace connector, include `workspace: context.workspace.id` from
its admitted context. A visible view may refresh only its own workspace; an updater can use only
current trusted visible contribution demand for that workspace. Multiple items share identical
refresh sources. There is no native work without visible demand. Explicit finite action handlers
include `actionId: invocation.id`; they retain their initiating caller and context while hidden,
and execute independently of refreshes. Updaters cannot manufacture actions or agent authority.
Effect declarations support presentation and later agent confirmation; they do not verify native
read-only execution.

The result contains `outcome`, `host`, `code`, `signal`, `truncated`, bounded byte counts, and an
optional `receipt`. `not-started` means admission refused before dispatch. `completed` means the
process returned an exit status, including nonzero: it does not claim tool-domain success.
`interrupted-uncertain` covers cancellation, deadline, truncation or dispatched transport failure;
changes may already have occurred. SSH channel closure does not prove descendant termination or
rollback. Treat `truncated: true` as an incomplete response even when an exit code is present.

Retrieve output with `connector.output` using `{ receipt, stream: 'stdout', offset: 0 }` (or
`stderr`). It returns `data`, a UTF-8 byte `nextOffset` or `null`, and the same explicit execution
result. Continue from exactly the returned offset. Pages fit the full 16 KiB JSON bridge envelope,
including encoding and metadata. Receipts belong to the initiating view/action and exact grant,
activation, host and context; they are not transferable to another guest. Send `{ receipt,
release: true }` when finished. They expire after 30 seconds and earlier when caller authority,
action lifetime, visible refresh demand or context ends. No page read extends an action.

Declarations choose a deadline of 1–180 seconds and up to 4 MiB combined output. Canonical
admission has a ten-second bound. At most four native executions run per extension and sixteen
globally, with at most four finite commands per logical host across installations; hvir queues
none. SSH finite channel reservations use the existing transport capacity owner independently
of ordinary buffered-exec slots and remain charged through actual close. They leave room for
ordinary work on the primary control transport without claiming availability against
preexisting saturation. At most four output receipts per extension, sixteen globally and
32 MiB including reserved execution output are admitted. A shared source has a one-second minimum
refresh interval and the source table is bounded. Output capacity is reserved before dispatch.
Canceled transports remain charged until they settle, even after the caller receives an uncertain
outcome. No stdin, PTY, filesystem API, persistent connector server or automatic command retry is
exposed.

The ordinary reference package works without native approval. To try native execution, configure
its optional `installed-tool` connector, then use **Run approved tool** and its JSON arguments.
The view displays the process outcome and bounded output pages. Its updater requests `--version`
while a contribution is visible and shows **Tool exit N** without opening a popup. Configure a
version-capable executable, such as an installed Skillager CLI. Native failure leaves the view and
ordinary navigation usable; revoke or repair the connector in Settings. A local real-tool
walkthrough should record the actual CLI source/version and use isolated user state. A separately
approved SSH workspace connector must record its real host and tool version for release acceptance;
local fixtures or an SSH label do not prove a real remote server.


## Explicit command in a fresh terminal

Declare and negotiate `terminal.start`. An exact current action requests it with
`{connector: 'setup-tool', workspace: invocation.context.workspace.id, args: ['init']}` and
`actionId: invocation.id`. The connector must be separately approved for the exact local
workspace. Its canonical executable, configured prefix/arguments and non-secret environment
bind this one operation; native approval alone does not authorize a terminal launch.

A main-owned human decision grants only the exact command and host-qualified destination.
Existing D6 standing or interactive agent authorization retains its action/host restrictions
and does not need a second modal. Ordinary guest requests cannot manufacture human or agent
provenance. The finite originating action remains current during the decision; after approval,
the one-use fresh-terminal admission expires in ten seconds. Expiry asks the caller to invoke
the action again. No unrelated guest, connector or smoke deadline changes.

The result is `handed-off` with the new terminal identity, `not-started` before physical dispatch,
or `interrupted-uncertain` if physical execution may have begun. The provider passes structured
positional arguments to a fixed bootstrap, runs the command once, and opens the ordinary default
login shell after its exit, including failure. It never types setup into an existing PTY. After
handoff the user owns the ordinary terminal; disabling the extension leaves it usable. Recovery
restores a plain shell and never replays the command or persists its arguments/configuration.
Observe the CLI's public metadata separately before reporting setup readiness.


## Selected current document sources

Declare `access: [{id: 'library', description: 'Read selected instructions', context: 'application', mode: 'read-only'}]` for an explicitly chosen local root, or use `context: 'workspace'` for one exact registered project/worktree chosen in trusted Settings. A workspace grant persists its registration identity and canonical host-qualified root; it covers no other current or future root or host and is revalidated on every body operation. Settings → Extensions → **Inspect read access** displays the canonical scope; **Grant read-only access** grants that declaration separately from native executable approval. **Revoke read access**, Disable, Reload and Forget saved setup revoke live selections. External library content is preserved. An application library never requires project registration; hvir's ordinary open-project requirement still applies.

For an explicit instruction selection, a current visible ordinary human view may request `source.request` with `{source: 'library', root: {hostId: 'local', path: '/reported/library'}}`. It covers only a declared application-local read-only source. Main prepares the canonical folder using the same owner as Settings, and trusted workbench UI supplies the human decision; the guest receives only `{granted: boolean}`, never an approval token or approve capability. An unchanged canonical grant needs no repeat dialog. Metadata, agents, actions, restricted views and updaters cannot obtain authority through this request. Hiding, closure, revocation, renderer replacement and the finite 60-second decision deadline retire the prompt; preparation or persistence stays physically owned until settlement, and interrupted persistence does not prove rollback. The package owns reported-library identity reconciliation before and after reading. Workspace and delivery grants retain their existing explicit Settings surfaces.

A visible human view requests `source.select` with `{source: 'library', path: {hostId: 'local', path: '/explicit/library/skill/SKILL.md'}}`. The returned caller-bound receipt names the current canonical path, byte count, read time and file SHA-256; it does not attest accepted tree contents. Request `source.read` with `{receipt, offset: 0}` and follow `nextOffset` until it is `null`. UTF-8 text is limited to 2 MiB; each page is at most 2048 bytes. A receipt expires absolutely after five minutes, including idle views, and must never be reported complete after an interrupted or expired page sequence. Use `{receipt, release: true}` when finished. There are at most eight physical/retained source reservations and 16 MiB of reserved receipt data application-wide. Closing or timing out a non-abortable read does not release its physical capacity until the host read settles.

`source.asset` accepts `{receipt, path: 'images/example.png'}` for a relative image confined canonically to the selected document's directory and grant. Images use bounded ProjectHost streaming, at most 2 MiB, and return MIME/type plus a separate base64-paged receipt. Raw HTML and ambient network/file resources are not part of this capability. Agents, actions, restricted-origin views and updaters cannot read instruction bodies, including requests omitting an invocation ID or reusing their own view. Hiding a view prevents new source admissions and late publication; already rendered UI bytes can remain visibly last-known.

`viewer.open-own` can transport bounded JSON `input` (6144 encoded bytes) to an exact own contribution. Optional `context: 'application'` is allowed only for an application contribution. Data confers no read grant and cannot change the main-owned caller origin or its intersected restrictions. `context.read` may include host-qualified `workspace.root` metadata, independently of read/execution authority. Optional root metadata is omitted when needed to keep the complete context within 7 KiB; absence means unknown, never inferred local discovery.

`source.reveal` reveals an ordinary directory in Files from a visible human-selected view.
Supply the declared workspace source, exact `workspaceId` and host-qualified `path`. It requires
that source's existing read-only grant and current registered workspace; main revalidates lexical
and canonical confinement, including symlink escape. Application sources, action/agent/updater
origins and stale workspace requests are refused. The one-shot owning-renderer navigation
reuses Files selection and expansion; it grants no file mutation or outside-root access.

The maintained ordinary [Skillager package](../packages/skillager-extension/README.md) provides personal-library browsing, project observations and selected current instructions through these public capabilities. It uses Skillager's public CLI schemas and explicit native/source setup; core imports no Skillager implementation.

`source.render` accepts an existing selected document `{receipt}` and produces a separate UTF-8-paged safe-HTML receipt, or `{receipt: null, sourceFallback: true}` when rendering exceeds 512 KiB. The package presents complete Source bytes on that explicit fallback. Parsing reuses hvir’s document Markdown policy off-thread in one lazy utility process with one physical parse, no queue/cache/host calls. Grant, origin, visibility and parent receipt checks apply before and after rendering; timed-out or revoked callers do not free physical parsing capacity before the worker RPC settles. Guest workers remain disabled.


## Explicit managed delivery

Declare an application `access` entry with mode `delivery-source` for an existing explicit local export folder, and a workspace entry with mode `managed-delivery` for one exact registered SSH workspace. Settings inspects and grants them separately. These grants do not allow `source.select`, instruction bodies, ordinary Files overwrites, or access to another workspace. The extension owns export approval and deployment meaning; core owns only mechanical custody and its private journal.

After a successful local connector execution, request `delivery.capture` with `{source, path: {hostId: 'local', path: '/granted/exports/one'}, nativeReceipt}` while that caller's native output receipt remains live. Capture independently confines and reads the complete ordinary tree. The returned receipt binds bytes and modes, not approval. Read every `delivery.manifest` page with `{receipt, offset: 0}`, following `nextOffset` to `null`, and compare the complete public producer manifest before preview. No body bytes are exposed. Release with `{receipt, release: true}`; release revokes dependent previews and does not free physically retained capacity until work settles. Captures last at most five minutes, with two captures, 512 total entries, depth 16, 2 MiB per file and 32 MiB per payload. Unsupported kinds, special permission bits and links are refused.

`delivery.preview` takes `{destination, target, kind: 'add'|'update'|'remove', capture?, sourceVersion?, record?}`. Every path is host-qualified. Update and Remove require the exact opaque current core record. The preview discloses the exact source, target, all missing supporting parents, preservation location, supporting files and delivery-record effect; its receipt lasts one minute. `delivery.apply` takes only `{receipt}`. Ordinary human views may confirm; admitted actions require their main-owned authorization and declared replace/delete effects. Updaters and unapproved callers cannot mutate. Selection, installation, grant, admitted workspace and caller lifetimes are rechecked.

Add requires an absent target. Update stages and verifies before preserving the unchanged old directory outside active discovery in `.hvir-delivery-retained`; Remove preserves that directory before cleanup. Publication uses no-replace rename. Supporting parents are exclusively created inside the destination grant after their intent is saved and remain shared user data. Directory identity includes native creation time; Linux/macOS hosts unable to supply the bounded native witness refuse managed mutations. Arbitrary external writers are not excluded atomically. Matching bytes alone cannot adopt another object.

Core persists operation intent under the extension state's exclusive write lease before remote effects. Results distinguish `refused`, `conflicted`, `completed` and `uncertain`. Failed completion saving leaves dependent authority pending. Restart/reconnect never replays mutation. `delivery.status` pages own current records or `{kind: 'operations', offset}` evidence with a journal `revision`; a complete multi-page observation must keep the same revision. `delivery.reconcile` takes `{operation, destination}` and inspects only exact journaled objects; `delivery.cleanup` additionally requires delete effects and removes only proven unchanged owned staging/preservation objects. Neither removes shared supporting parents. There are at most 64 pending or retained operation records, 128 current records, 256 MiB possible retained payload accounting and a 4 MiB complete journal. Completed operations without retained objects do not consume history capacity; current delivery authority remains durable. Exact-target physical reservations allow unrelated destinations to proceed, with at most two physical operations; only journal persistence is serialized. Mutation has a three-minute bound; cleanup has a 30-second bound. Capacity refusal retains data. Complete metadata must fit the existing public envelope; pages never truncate one manifest entry.

`delivery.domain` reads `{value, revision}` for only the current installation. Writes use `{write: true, expected: revision, value}` and reject stale revisions. Evidence-dependent compaction also supplies `journalRevision` from the complete core observation; a changed journal refuses that write. This data is bounded to 4096 encoded bytes per installation and 256 KiB total, separate from package assets and core authority. It cannot create or edit core records. Extensions own their exact domain reconciliation and capacity resolution.

Disable and package changes preserve delivered files and installation-scoped authority. Settings removal keeps saved setup by default. Explicit forgetting removes completed authority and domain data, with plain-language disclosure that files remain ordinary user data. Pending/retained operation evidence survives forgetting. Trusted Settings → Extensions → Delivery recovery can inspect exact objects and known/unknown supporting-parent identities, reconcile proven completion, clean unchanged owned leftovers, or explicitly keep every object and end tracking against fresh facts. Keeping files neither cleans them nor proves an unknown original completion, and does not grant a new same-ID installation the old authority.
