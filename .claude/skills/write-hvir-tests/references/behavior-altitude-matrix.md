# hvir behavior and test-altitude matrix

This is a stable map from behavior ownership to required evidence. It does not record test counts,
current migration status, temporary duplication, or acceptance history. Start with the lowest
real altitude in the middle column and retain the higher-altitude evidence in the last column when
that environment supplies part of the contract.

| Capability and contract | Stable owner and lowest real evidence | Environment contract that must stay real |
| --- | --- | --- |
| Workbench selection, layout, attention rollup, recovery choice, and resource planning | Feature reducer, selector, or planner; direct policy tests | Electron window lifecycle, focus, renderer recovery/destruction, and platform geometry use focused Electron scenarios |
| Workbench owner/generation revocation | Renderer/window lifecycle owner through narrow ports; deterministic generation and deferred-completion tests | Real renderer reload, crash, destruction, and replacement-generation behavior use Electron |
| Viewer mode defaults, mode transitions, anchors, navigation, and split policy | Viewer policy/model; direct tests or narrow fake viewer ports | CodeMirror materialization, virtualization, selection, scroll, remount, and platform geometry use Chromium/Electron |
| Viewer rendering and worker handoff | Viewer coordinator and immediate worker adapter; fake only the worker/process boundary | Shiki/worker transfer, large-document paint containment, and real cross-process failure use focused Electron scenarios |
| Rendered HTML and Markdown security | Preview policy, sanitizer, and protocol adapter at their immediate boundaries | Response-header CSP, sandbox behavior, navigation blocking, and hostile Chromium content use real Electron/Chromium |
| Git parsing, validation, graph lanes, branch/sync policy, and diff-base semantics | Git capability policy and parsers; direct tests, with mutation measurement where configured | Mutation score measures constraint strength only; it does not establish intended semantics |
| Git command construction, authorization, cancellation, and bounded output | Git capability adapter with fake immediate command/host boundary | System-Git argv, worktrees, dirty navigation, real repository state, and worker/main process boundaries retain integration or Electron evidence |
| Filesystem and Git responsiveness | Off-thread coordinator/worker protocol through narrow ports | Paint responsiveness during large reads, history, diff, ignore, and worker activity uses focused Electron or controlled capacity evidence |
| Terminal split, attention, presentation, and recovery planning | Terminal feature policy and provider-neutral models; direct tests | Ghostty canvas, resize/reflow, input, selection, reconnect/remount, focus, and platform geometry use Electron |
| Harness profile validation, composition, grants, revisions, risk, and exact recovery planning | Main-owned profile/provider policy with isolated domain fixtures | Real bundled provider CLI behavior and provider-owned persistence formats use focused adapter or real-host evidence as applicable |
| PTY supervisor authorization and lifecycle policy | PTY supervisor through `ProjectHost` and provider ports; deterministic fake ports and explicit disposal | Real spawn, output, input, exit, termination, and native node-pty ABI use a main-process Electron scenario |
| Harness observation and title normalization | Bundled provider implementation; direct structured-record tests | Real CLI/version/persistence observations stay provider-focused and host-specific; never parse terminal screen text in a fake |
| Workspace/project transitions, registration, discovery, and restoration | Workspace/project model or named coordinator; direct policy and narrow-port tests | Real Git worktree discovery, renderer hiding/restoration, and window destruction retain integration or Electron evidence |
| Project filesystem, watch, and loopback operations | `ProjectHost` contract and LocalHost/SshHost adapters; fake only immediate OS or transport dependencies | OS watcher behavior and real SSH server/SFTP/watch semantics stay integration or real-host evidence |
| Host-qualified authority and confinement | Shared `HostPath`/root policy plus each main-owned authority adapter; direct boundary tests | Real symlink, repository, SSH, and platform path behavior remains adapter/integration evidence on supported hosts |
| IPC manifests, validation, routing, and sender/owner qualification | Feature IPC registrar and authority router; direct tests with a fake application port | Cross-process serialization, destroyed senders, renderer generations, and preload availability use Electron |
| Web-pane activation, provenance, endpoint authorization, and navigation policy | Web-pane policy/coordinator through narrow route, surface, and terminal-provenance ports | Guest attachment, Chromium isolation, authenticated proxy challenges, navigation, input, and webContents destruction use Electron |
| Web-pane route, proxy, session, and stream lifecycle | Main-owned route registry and immediate network/ProjectHost adapters | Real loopback traffic, WebSocket behavior, SSH direct forwarding, guest sessions, and backpressure retain Electron or real-host evidence |
| Diagnostics schemas, admission, bounds, redaction, and owner generations | Owning feature sanitizer and bounded diagnostics policy; direct policy and narrow sink tests | Electron lifecycle observations and packaged persistence stay focused Electron or installed-package evidence; captured content remains excluded |
| Local/SSH parity | Host-neutral policy over explicit host-qualified ports, followed by deterministic LocalHost and SshHost adapter contracts | Real authentication, host keys, exec, SFTP, PTY, reconnect, loopback forwarding, and server limits require opt-in real-host acceptance |
| Packaging, installation, update, launcher, migration, uninstall, and purge | Package/installer policy plus disposable filesystem/process adapters where possible | Built native artifacts on a matching disposable host use the installed-package commands; unpackaged smoke is not a substitute |
| Capacity admission, cleanup, topology, and deterministic delivery | Capacity/resource policy directly or through narrow owners | Real PTY, process, channel, backpressure, cleanup, and recovery contracts use the capacity Electron group |
| CPU, latency, frame cadence, paint, and working-set budgets | No unit-test substitute; deterministic setup policy may be tested directly | Quantitative evidence runs only on the controlled-machine capacity gate; hosted measurements remain labeled evidence |
| Scenario repetition and interruption isolation | Scenario launcher policy and owned-root/resource markers; direct process-orchestration tests | Each iteration uses a fresh Electron process and roots; signal/force-kill successor isolation uses real child processes without retries |
| Higher-altitude failure artifacts | Scenario-owned closed schema and bounded artifact writer; direct allowlist/bounds tests | Electron/process failures supply only reviewed, bounded, content-free semantic and exit evidence |

## Selection rules

- A fake proves only the behavior above the port it replaces. It cannot prove the replaced
  environment.
- Renderer chrome that says “SSH” does not prove `SshHost`, transport, or server behavior.
- A mocked terminal canvas does not prove Ghostty, Chromium selection, reflow, or node-pty.
- An in-memory Git response does not prove system Git, repository topology, worktrees, or worker
  process behavior.
- An unpackaged Electron launch does not prove installer, updater, launcher, migration, or native
  artifact behavior.
- A hosted timing sample is evidence, not a controlled quantitative gate.
- A passing mutation score cannot show that the asserted behavior is the intended behavior.
- A stable higher-altitude scenario may remain when it is the only evidence for a real boundary;
  do not remove it merely because lower policy coverage was added.
