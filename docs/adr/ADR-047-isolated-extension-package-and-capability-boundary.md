# ADR-047: Isolated extension packages and the public capability boundary

> Lifecycle: Active
> Supersedes: [ADR-007](ADR-007-explicit-view-modes.md) | partial | Requiring rendered, source, or diff modes for every viewer tab; extension UI uses only its declared meaningful representations.
> Supersedes: [ADR-012](ADR-012-harness-providers-launch-profiles.md) | partial | General extension-platform prohibition only; trusted bundled harness providers and their separate SDK decision remain unchanged.
> Supersedes: [ADR-014](ADR-014-modular-monolith-ownership.md) | partial | Excluding a plugin platform or additional isolation boundary; capability ownership, inward dependencies, lifecycle, styles, and test discipline remain unchanged.

## Context

Users need view-first integrations without maintaining an hvir fork. The 0.3.0 extension
platform deliberately replaces the general extension prohibition. It does not replace the
editing guardrail, terminal ownership, trusted harness providers, or host-qualified project
authority. User packages are untrusted callers; the internal workbench preload and IPC contract
cannot become their API.

The first useful slice is an ordinary directory package that a user explicitly enables and
opens in an isolated viewer. It must work without rail, connector, mutation, agent, or authoring
tool capabilities. Skillager provides a concrete later consumer: its personal library can be
browsed and read independently of project registration and content approval.

## Decision

### Scope and existing authority

Permit user-installed extension packages for bounded viewing and explicitly admitted actions.
No third-party code executes in privileged main or the trusted workbench renderer. Extensions
do not supply harness providers, terminal engines, raw PTY access, task/build systems, or serious
editing. Native connectors require their own explicit admission; sandboxed guest approval is
not a promise that an executable is sandboxed against its host account.

The existing IPC authority router still governs trusted workbench IPC. Project registration,
the viewer, Settings, `ProjectHost`, the PTY supervisor, harness providers, and `TerminalPane`
retain their domain authority. Application-level placement conveys no access to all projects.
hvir continues to require an open project; a library view is not a zero-project mode.

### Named owners and dependency direction

Package management owns discovery, manifest validation, immutable revision capture, and
installation identity. Activation owns accepted revisions, enabled state, and activation
generations. Guest lifetime owns guest admission, attachment, sessions, bounds, and disposal.
Capability admission owns caller identity, negotiated capabilities, grants, target validation,
and request revocation. Contribution placement owns declared contribution identity and
application/workspace placement through narrow viewer ports. Settings supplies trusted
permission and revision controls. Roots construct and connect these owners, rather than
implementing their workflows.

Public contracts contain data and narrow ports, importing no main, renderer, worker, Electron,
or extension-package implementation, including type-only imports. Guest transport adapters
depend on capability owners; owners depend on domain ports. Core does not import Skillager or
other extension packages. Guest presentation code cannot import private workbench components,
DOM, or stylesheets. Existing dependency and source-budget enforcement applies. The consuming
runtime child adds focused public-contract and extension-package direction rules where existing
checks do not cover those boundaries; no budget relaxation is implied.

### Minimum package and accepted revision

The manifest declares a bounded stable package ID, display name, package version, target public
contract version, required and optional capability IDs, requested access, package-relative entry
assets, and viewer contributions with stable IDs, title, entry, placement, and representations.
Package version, contract version, captured revision, and installation identity are distinct.
The initial package may request no project access and contribute one application-level view.
Connector declarations are absent in this slice; a declared unsupported required capability
fails visibly before execution.

Validation reads data without executing package code or install scripts. It verifies manifest
shape, supported contract and required capabilities, bounded files/counts/bytes, entry existence,
and canonical containment. Absolute entries, traversal, escaping symlinks, and ambiguous assets
are refused. D2 captures the validated directory into an immutable content-addressed package
store, with manifest and entry assets belonging to that exact revision. Activation and protocol
responses serve only captured bytes; validation followed by reads from the mutable source is
insufficient. D3 extends this same owner for ZIPs, development links, replacement, removal, and
bounded retention; it does not introduce another validation or activation path.

An installation has a persisted identity distinct from its manifest ID and source path.
Explicit Enable, Reload, or Replace accepts a validated revision for that installation. Discovery
never activates an externally replaced or reappearing package. The ordinary enable/replace
action explicitly accepts its revision and installation identity. A changed source cannot
silently change a live activation. Revocation precedes retiring its guest resources.

Permission approval binds to requested access, connector declarations and configuration, and
the host and canonical path of each approved executable. Unchanged values need no new permission
decision after an explicit revision action. Changed access requires a new decision. Do not hash
interpreted tool contents as executable approval. Package revision hashing captures package
bytes; it is not executable trust or Skillager content approval. D3 defines removal controls
that state whether installation identity and delivery records remain.

### Extension-state write ownership

Support one extension-writing instance per user-data directory. A narrow extension-state write
guard protects authority-bearing grants, installation/revision state, delivery records, and
package-retention decisions. A second application launch may open the workbench but cannot
acquire conflicting extension write or operation authority; ordinary workbench use remains
available. Separate development data directories work independently.

Losing write ownership revokes dependent extension work before cleanup. A later owner reloads
persisted state before admitting work, rather than using an earlier in-memory copy. Persist
authority state atomically. This is not an application-wide single-instance restriction or a
shared-state synchronization framework. Later delivery operations retain their own narrow
record owner; this decision introduces no general transaction framework.

### Isolated guest surface

Use Electron `<webview>` behind a replaceable extension guest-surface adapter. Each visible view
has its own guest and separate in-memory Electron session, isolated from the workbench, loopback
panes, and other guests. Main binds an attachment once to the exact accepted installation,
revision, activation generation, view, workbench renderer owner/generation, initial extension
URL, and session. Guest-supplied identity fields are never provenance. Set the hvir-owned
preload in main after validation; reject injected preload, partition, and preference changes.

Follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security):
disable Node integration, enable context isolation, process sandboxing, and web security,
validate IPC senders, constrain navigation and window creation, and expose only narrow bridge
functions. No workbench preload bridge, arbitrary IPC channels, permission grants, popups,
downloads, DevTools, or direct filesystem authority are exposed. Guest dialogs and
`beforeunload` cannot veto hvir revocation.

Serve captured assets through an extension-only protocol bound to that guest and revision.
hvir sets response-header CSP before bytes, denies permission requests, blocks WebRTC, and
cancels requests outside that protocol. Guests have no network access, including loopback;
connectors are the only future extension network path. Admission and message bytes, output,
requests, concurrency, and guest counts are bounded per extension and application. D2 owns
concrete finite limits and visible refusal/crash states, without unbounded queues or silent
eviction. Expensive capture and reads stay off paint.

ADR-013 remains active in full. Its loopback guests have no preload or extension capabilities
and retain their authenticated routes, network policy, and terminal provenance. An extension
guest has no loopback-pane route or proxy authority. Shared surface mechanics may be reused
behind narrow adapters; sessions, attachment admission, and caller authority remain distinct.
Existing ADR-007 HTML preview isolation likewise remains unchanged.

### Minimum bridge and public capability contract

The hvir-owned preload exposes the public guest bridge, not Electron APIs. Its initial message
families are contract/capability handshake, correlated capability request/result, cancellation,
presentation data updates, and lifecycle revocation. D2 supplies their bounded schemas. Main
derives caller identity from the admitted guest, validates every message and target, and rejects
requests before successful negotiation. A request cannot assert that a trusted user approved it.

The initial operations provide current presentation data and opening the caller's own declared
viewer contribution with bounded public input. They cannot open arbitrary guest URLs or another
installation's contribution. Placement resolves through the contribution owner; it cannot
register a project, enumerate hosts, read project files, execute a connector, mutate, or launch
a terminal. Trusted Enable/Open controls and a self-contained directory package suffice for
the initial walkthrough. Later capabilities are added by their owning child before use.

Extension views and later `hvir-agent` transports adapt one public capability contract through
the same owners. They remain distinct caller classes with separate admission and transport;
guest attachment is not agent authorization. D4 may admit at most one sandboxed update runtime
per active extension while visible contributions demand updates. It has no workbench DOM, Node,
direct network, hvir mutation, terminal handoff, or agent-action authority. D2 introduces no
updater. D4 records its own focused lifecycle before implementation.

Every admitted operation checks caller, capability, grant, host, target, activation generation,
and relevant workspace/view/request lifetime. Use `HostPath` and `ProjectHost` for project
operations; placement, a selected workspace, or a response from an external tool never widens
authority. Revocation rejects late results before publication. Disposal is idempotent and
reverses ownership order. Disable, replacement/removal, workspace closure, host disconnect,
renderer replacement, and application exit revoke affected descendants. Completed effects and
explicitly handed-off user terminals keep their ordinary owners and truthful outcomes.

### Version negotiation and safety

The released public contract begins at 1.0, independently of hvir's 0.3.0 application version.
A package declares its target major/minor version and required/optional capabilities. Handshake
returns the supported contract and admitted capability set. hvir activates same-major packages
targeting an equal or lower minor, and newer-minor packages when every required capability is
available. An unsupported major or missing required capability refuses activation visibly; a
missing optional capability leaves independent supported features usable. Grants still govern
use of an available capability.

After release, changes within a major only add behavior. Removal or a change of meaning requires
a new major; hvir accepts the previous major for a stated period published with that release.
Newer-minor callers can use a supported subset only when all their required semantics are
negotiated. Every new safety precondition or operation meaning requires an explicit negotiated
capability that the caller verifies, never an unknown field an older host might ignore.
Manifests and messages ignore unknown fields and report them as bounded validation warnings.
Ignoring fields cannot authorize a weaker operation: unknown authority/safety claims confer
nothing, and known schemas, required capabilities, and grants remain enforced. Unknown
operations are refused and unknown required capabilities prevent activation. Required semantics
cannot silently disappear. Unsupported messages name the required contract and capability; a
minimum application release is named only when the manifest or supported installed capability
metadata supplies that mapping. Theme token names are versioned contract; their values may change.

Pre-release iterations intentionally update current consumers directly, removing superseded
implementations. There is no legacy contract fallback, shim, migration, or parallel old path.
Released reference and clock packages become frozen compatibility fixtures in cumulative
acceptance; later starters do not rewrite them.

### Viewer presentation and placement

Contributed UI is a closable ordinary viewer tab identified by installation and contribution,
with visible extension ownership and bounded title. It has only declared meaningful
representations: a custom UI may have just its primary view. Do not fabricate Source or Diff
modes from arbitrary UI. A selected real document continues to use the existing viewer's
rendered/source/diff model and read protections. Representation controls appear only when
multiple supported representations exist; selection remains explicit and sticky for the tab.

Application-level tabs stay visible and selectable when the user changes workspaces. They do
not acquire the newly selected workspace's authority. Workspace-scoped contributions appear
only in their admitted workspace and are revoked on its closure. D2 keeps contributed tabs and
guest state transient across application restart and renderer replacement: no guest session,
arbitrary serialized UI state, or automatic reopen is restored. Later restoration requires
bounded public state plus fresh admission, rather than private implementation snapshots.

Initial presentation data includes light/dark appearance, semantic colors, interface font and
scale, and available viewport dimensions. It conveys no capability or private styles. Existing
theme/settings owners supply updates. D11 owns the shared tokens, primitive styles, and public
guest UI kit from the same source as built-in UI; completing that kit does not gate D2.

### First Skillager library-to-document journey

The user enables the Skillager package, explicitly approves its needed executable/library read
access, and opens an application-level personal-library view. Skillager's supported public CLI
supplies personal-library inventory and paginated search, including authoritative source identity
and location. The user searches or browses, selects a skill, and reads its current instructions.
Readable content comes from a bounded `ProjectHost` read of the public-contract-identified
`SKILL.md`, confined to the explicitly admitted host-qualified personal-library root and selected
source. Neither private Skillager state nor an hvir scanner supplies inventory or approval.

The library does not need registration as a project. Reading requires neither content approval,
workspace setup, nor mutation authority. It never executes instructions, accepts a version, or
authorizes exposure. Unavailable project metadata or a blocked mutation does not disable
independent library reading. Exact connector operations belong to D5 and inventory/search/read
integration to D7, consuming supported upstream CLI contracts. Approval, identity, search, and
mutation policy remain Skillager-owned; hvir enforces its access and lifetime boundaries.

## Consequences

The package-to-view slice is independently usable while later features extend one capability
boundary. Isolation adds Electron guest/session and protocol ownership that must be proved in
real Electron coverage alongside owner-level contract tests. Finite bounds may refuse work;
unavailable capabilities and revoked state must remain visible and truthful.

The extension platform intentionally widens the integration surface while preserving the
view-first product and established host, provider, terminal, and document owners. Permission
reuse makes explicit revision changes practical without treating discovery as execution or
confusing sandboxed UI with host-account executable authority.

## Rejected alternatives

- Loading package code in main or the trusted renderer exposes workbench authority.
- `WebContentsView` draws above DOM menus and dialogs; it does not fit the workbench surface.
- A sandboxed iframe does not guarantee isolation from the workbench renderer.
- Reusing workbench IPC, loopback sessions/routes, or a general service locator conflates
  authority and makes guest revocation ineffective.
- Mutable-source serving after validation permits unaccepted bytes to execute.
- Registering the personal library as a project or requiring approval to read conflates
  independent browsing with workspace and mutation authority.
- Designing every connector, rail, agent, or mutation capability first delays a useful minimal
  view without improving its boundary. MCP and MCP Apps are not platform dependencies.
