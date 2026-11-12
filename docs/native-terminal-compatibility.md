# Native terminal compatibility and qualification

This inventory belongs to [#1108](https://github.com/jarmak-personal/hvir/issues/1108).
[ADR-086](adr/ADR-086-native-terminal-state-and-presentation.md) and the
[native contract](native-terminal.md) state the selected ownership. Rows describe required
observable behavior, executable baseline fixtures, native API fit and future proof. They
are acceptance inputs, not a progress checklist or a claim that native compatibility passes.
No user-visible difference is approved by this inventory.

## Baseline identities

The inspected behavior baseline is hvir main `8874f7902fa1231c7e46200929ee71b5db532f82`.
Its lockfile selects Electron **43.8.1**, Chromium **150.0.7871.250**, and the ghostty-web
**hvir-v0.4.0-20** artifact, source `18fc0d2bddb0`, with Ghostty core **1.3.1**. Retain the
lockfile integrity and complete fork provenance when running comparisons; a short source
prefix is an identifier here, not an artifact-integrity check.

The selected first native build candidate is full Ghostty source at
`108cacb17ed8990840cd14abfce43d8ed8503ca1` (VT **1.0.1** tag), **Zig 0.17.0**, ReleaseFast.
The full source's application version is **1.4.1-dev**; record it separately from the VT
library and private-facade versions. `build.zig.zon` requires Zig 0.17.0. The prepared macOS contributor toolchain is Xcode **26.2 (17C52)** / SDK **26.2**,
Apple Metal toolchain **17C7003j**, compiler **32023.864**, selected with a task-local
`DEVELOPER_DIR`. That is build readiness, not compiled artifact or package evidence.
M2 (#1109) records
the exact toolchain binary, complete source/dependency hashes, patch set and artifact hashes.
The VT-only source tarball cannot supply the native renderer. Stable 1.x C ABI compatibility
does not cover private Zig interfaces, native rendering, or snapshot bytes.

Historical qualification used Ghostty **1.4.0**, source
`83fb95624b0439ee660c2679b43b38c8b63769cd`, Zig 0.17.0 ReleaseFast, on Apple M2/macOS
**15.7.3 (24G419)**, approximately **60 Hz**, Retina scale **2**, **Menlo 14**, initial
**100×30 / 1800×900** demo geometry, with explicit **+1 cell width / −3 cell height**
adjustments. Electron/Chromium match the versions above. Those prototype adjustments are
confounders to remove through real font metrics, not production defaults. Mac scrolling,
typing and corrected width changes received positive hands-on feedback; its isolated
timers do not establish full-app or physical display latency. Preserve the reports under
[`research/native-ghostty/`](research/native-ghostty/README.md), including pending #1094.

Linux GPU presentation remains unresolved. The old Linux script's unsupported-platform
diagnostic does not render a terminal. The selected full source's embedded platform union
still lacks Linux while its internal OpenGL renderer can export DMA-BUF. M4/M6 require
actual process transfer, immutable leased frame delivery and real desktop interaction.

## Fixture-backed workflow inventory

For each row, run its listed existing fixtures with `npx vitest run <paths>` from the
selected worktree. These fixtures establish their named owning behavior, not a native
GPU proof. Native implementation must exercise the equivalent port/real platform boundary
and retain these behavioral checks. Engine-specific adapters may change; an absent native
implementation cannot pass by skipping the row or returning a no-op.

| Workflow | Required current behavior and executable fixtures | Native API fit / adapter or patch | Native acceptance owner and proof |
| --- | --- | --- | --- |
| Launch/recovery/profiles | Exact host/provider/PTY identity; explicit fresh/resume/fork and missing-artifact refusal; no shell from catalog discovery. `test/pty-supervisor.test.ts`, `test/terminal-recovery-planner.test.ts`, `test/terminal-fork-launch.test.ts`, `test/terminal-workspace-materialization.test.tsx` | VT owns no PTY; remove private Exec backend, use external feed and acknowledged initial geometry. Existing provider launch policy remains outside engine. | M3/M7/M13: two independent real terminals, no extra shell, exact recovery/fork and local/SSH identity/lifetime tests. |
| Input/TUIs | Submit/newline/provider overrides, Unicode, navigation, controls, paste, focus, alternate-screen/mouse scrolling and shortcuts. `test/ghostty-terminal-keyboard.test.ts`, `test/terminal-wheel.test.tsx`, `test/terminal-runtime.test.tsx` | Public key/mouse/paste/focus encoders are useful; current-mode reads must use the authoritative parser. DOM IME/dead-key/input host remains an adapter. | M8: actual Electron keyboard/composition/mouse paths, exactly one intended write, stale attachment refusal; platform IME/manual harness recipe. Do not claim unresolved #64 behavior is an existing guarantee. |
| Geometry/rendering | Real pane/window/split fit, latest font/palette during initialization. `test/ghostty-terminal-fit.test.ts`, `test/terminal-layout-controls.test.tsx`, `test/terminal-output-parity.test.tsx` | Private native facade needs applied geometry serial before PTY SIGWINCH; renderer completion/export and platform scaling require patches/adapters. | M3/M5/M6/M7/M12: same-size and superseded resize, font/DPI change, stale-frame rejection, real shared-texture presentation and no routine GPU readback. |
| Scroll/selection | Scroll position, drag/word/line/select-all, exact copy and clear/reset; search reveal preserves selection. `test/terminal-wheel.test.tsx`, `test/terminal-context-menu.test.tsx`, `test/ghostty-terminal-search-identity.test.tsx` | Public selection/gesture, grid references and formatter algorithms can serve the same native state through the facade; DOM hit testing and current input lease need adapters. | M8/M9/M10: scrollback and TUI scrolling, exact wrapped/Unicode whitespace selection, resize/reflow and stale/evicted selection; Electron/context-menu and manual drag evidence. |
| Search/semantic navigation | Live literal/case-sensitive matching, ordering/count/high-match bounds, exact authenticated extraction and stale rejection. `test/terminal-search-controller.test.ts`, `test/ghostty-terminal-search-identity.test.tsx`, `test/terminal-semantic-navigation.test.tsx`, `test/terminal-semantic-regions.test.ts` | Inspected public search folds ASCII case; case-sensitive matching needs bounded adapter/patch. Tracked references alone do not authenticate an overwritten occurrence. Preserve half-open extraction over native inclusive selections. | M10/M11: same-state query/cancellation, high-match/streaming fixture, provenance across screen/reset/eviction/reflow; no full text mirror or second parser. |
| Clipboard/paste | Explicit text/file/image targeting and original fallback bytes; bounded authorized OSC 52 writes, no terminal reads. `test/terminal-clipboard-file-paste.test.ts`, `test/terminal-clipboard-write.test.tsx`, `test/terminal-clipboard-osc.test.ts`, `test/clipboard-ipc.test.ts` | Public encoders/effects supply data, not clipboard authority. Retain protocol/selector/encoded-size provenance when normalizing decoded callbacks; do not enable iTerm2/Kitty writes silently. Preserve strict UTF-8/size/liveness checks and deny OSC 5522 reads too. | M9/M11/M13: exact live PTY/provider bindings, local/SSH fallback/staging/revocation, no submit or stale write; platform clipboard and approved remote image tests. |
| Links/metadata/attention | User-activated host-correct file/web/loopback links, titles/cwd/bell/notification/progress, focus-clears and distinct Working. `test/ghostty-terminal-hyperlink.test.tsx`, `test/terminal-file-link.test.ts`, `test/terminal-path-activation.test.ts`, `test/terminal-attention.test.ts`, `test/terminal-event-router.test.ts` | Native stream effects/action callbacks need copied bounded events and parser provenance. Disable native open/config/window/split actions and file/shared-memory media. | M11: exact explicit activation and host, bounded malformed effects, replay/trailing-output rejection and palette/reply attribution; actual Electron link and attention tests. |
| Workspace/Sessions | Retain one state/PTY across hiding, handoff, splits/focus mode and workspace moves; at most one input owner. `test/terminal-surface-attachment.test.ts`, `test/terminal-sessions-surface-owner.test.tsx`, `test/terminal-workspace-move-coordinator.test.ts`, `test/sessions-terminal-ssh.test.tsx` | New state/attachment ports replace DOM-local ownership. Native show/hide and fresh attachment serial cannot destroy or duplicate session state. | M7/M13: real surfaces and renderer generation changes, rapid move/resize/reparent, hidden output/reveal, close with pending jobs, no duplicate PTY/input. |
| Settings | Live theme/palette/typography/ligatures/cursor defaults and application overrides without PTY restart. `test/terminal-palette.test.ts`, `test/terminal-theme-gallery.test.tsx`, `test/terminal-output-parity.test.tsx`, `test/ghostty-terminal-pane-lifecycle.test.tsx` | Native config adapter maps hvir values to the same renderer state; query replies and displayed palette agree. Real native shaping and metrics replace prototype constants. | M12/M11: existing settings behavior plus fonts/CJK/emoji/combining/ligature/cursor, hidden update and DPI/missing-glyph platform evidence; record appearance differences explicitly. |
| Failure/remote | Current SSH disconnect/reconnect, host-qualified identity, fail-closed late input/effects and cleanup. `test/pty-supervisor-late-completion.test.ts`, `test/pty-ownership.test.ts`, `test/ssh-host.test.ts`, `test/ssh-transport-pool.test.ts`, `test/terminal-effect-generation.test.ts` | New shared-host loss and GPU-context failure outcomes; retained PTY and lost native state are distinct. Current bounded replay cannot reconstruct arbitrary state. | M4/M13: crash/revocation/OS-resource fault injection and real local/SSH transitions; explicit recovery only. Real-host coverage unavailable is a named M15 gap, never a pass. |
| Accessibility | Current focus/keyboard navigation/input/composition and accessible controls. `test/terminal-layout-controls.test.tsx`, `test/terminal-search.test.tsx`, `test/terminal-context-menu.test.tsx` | GPU pixels provide no DOM text accessibility. Preserve the current input host and accessible control semantics; neither engine is presumed to offer a complete screen-reader transcript. | M7/M8/M9: Electron focus/composition/candidate positioning plus platform assistive-tech/manual checks. Inventory current limitations independently; no regression may be relabeled an existing limitation without evidence. |

Run existing `npm run verify`, applicable `smoke:macos`/`smoke`, terminal presentation/lifecycle,
capacity, and installed-package checks at their actual owning altitude. M15 (#1122) runs the
full Linux gauntlet, controlled capacity and installed candidate acceptance; macOS needs its
supported smoke/capacity/package evidence. Adapt telemetry to observe behavior rather than
an engine implementation name. Real Linux hardware, signed/relocated macOS and target-ABI
packages remain independent gates. Local success cannot certify Linux or an untested driver.

## Existing limitations and adjacent work

The inspected issue state records these open boundaries separately from migration regressions:

- **#64:** web wheel reports exist, but TUI mouse-button press/release is missing. Native input
  can supply its ordinary button protocol; coordinate its focused acceptance rather than
  claiming the old adapter already supported it or closing the issue without evidence.
- **#285:** same-main live-PTY reattachment is mixed with durable recovery decisions after
  renderer rollover. Native state surviving presentation replacement does not, by itself,
  repair that recovery UI. Preserve exact PTY/state identity and coordinate M7/M13 without
  expanding this migration into universal rollover recovery or claiming the issue resolved.
- **#949 / #950:** Ubuntu Claude local image paste and Codex/Claude SSH image paste have
  unresolved real-desktop failures; right-click Paste currently reads text rather than
  invoking the SSH image coordinator. M9/M15 distinguish existing supported paths, these
  reported failures and any agreed extension, and retain the actual Linux/manual evidence
  gap. A new renderer or synthetic transfer success cannot prove model receipt.
- **#1080 / #1086:** persistent SSH attachment/tmux behavior belongs to its existing effort.
  Re-read its accepted transport contract at integration; no persistence behavior is supplied
  by an app-host native parser. Preserve host-qualified input/reply and lifetime routing.

No adjacent issue is closed by this document. M15 must identify unresolved rows and obtain
an explicit accepted difference where needed; this list neither silently removes a required
workflow nor treats a reported baseline failure as proven native compatibility.

## ADR disposition after native review

The review includes terminal-applicable rules in every ADR through ADR-085 at the baseline.
“Retain” below means the decision was considered and has an independent reason to remain;
it does not preserve obsolete method names, owner placement or transport mechanisms. All
terminal decisions remain revisable by later focused decisions without permission merely
because they are ADRs. Existing supersession chains remain historical truth.

| ADR | Selected disposition and rationale |
| --- | --- |
| 001–002 | Retain Electron/React shell and off-render-thread responsiveness: they serve the workbench; native terminal work moves off both UI event loops. |
| 003 | Partially replace engine choice, stable-Linux prerequisite and single-widget seam with ADR-086: pin/private patches plus explicit platform gates. Retain transient focus layout and typed explicit link activation because native state need not own UI/navigation. |
| 005, 007 | Retain explicit Git operation handoff and terminal shortcut isolation: native rendering does not grant Git mutation or view-mode input authority. |
| 006 | Retain exact provider-owned conversation recovery and centralized PTY authority: neither native parser state nor screen text establishes harness identity. Native-host loss gets a separate explicit unavailable-state path. |
| 008 | Retain host-qualified project/workspace model, live background PTYs and per-workspace layout, subject to existing successors: native rendering changes presentation, not workspace identity. |
| 009, 019, 034 | Retain focus clearing, actionable aggregation, provider-neutral Working/Ready and accessible/reduced-motion presentation: native effects and user-input attribution replace the event source. |
| 010 | Retain host qualification and ProjectHost transport/PTY authority: native app-host rendering must not read or spawn directly on a project/SSH host. Reuse the current accepted remote-client exception. |
| 011, 018 | Keep superseded: historical npm delivery and script-free payload decisions are not revived by adding a native library. |
| 012, 015, 020, 031, 036, 039 | Retain reviewed current provider/profile revisions, exact resume/fork, missing-artifact refusal, skip retention, truthful telemetry and retired risk rules: these are harness/data decisions independent of GPU presentation. Do not preserve superseded rules. |
| 013, 045 | Retain explicit loopback/file navigation and outside-project viewing boundaries: copied native link metadata cannot itself grant network/file access or retarget a host. |
| 014 | Partially replace terminal facade stability/process placement with ADR-086. Retain capability ownership, inward runtime/type dependencies, composition-only roots, revocation and test altitude because the native boundary needs stronger, explicit lifetime proofs. |
| 016, 025, 046 | Retain content-free bounded diagnostics and retirement of speculative responsiveness recording: measure terminal improvement in existing test/capacity owners, without adding a production observer framework. |
| 017, 032, 043 | Retain current explicit review-delivery exception and exact payload/destination/provider framing; terminal rendering provides no authority for ambient report/prompt injection. |
| 021, 023, 027, 033 | Retain current Git safety, explicit close, demand-driven workspace work and authoritative missing-workspace cleanup: catalog changes must revoke the actual native owner without allocating terminals from discovery. |
| 022, 028, 029, 044 | Retain native package lifecycle, Linux ABI/sandbox baseline, and distinct macOS acceptance channel: adding terminal artifacts cannot inherit developer loader paths or alter installed support silently. |
| 024 | Partially replace renderer-owned live parser/presentation coupling with ADR-086. Retain demand-driven allocation and distinct registered/materialized/session/live/visible/focused states because they bound idle work and preserve user sessions. |
| 026 | Retain explicit image gesture, original fallback bytes, exact provider/PTY/host authority and bounded private SSH staging: native rendering supplies input events, not attachment acknowledgement or image-storage policy. |
| 030 | Retain clipboard/file-transfer targeting, bounded ProjectHost operations and distinct copy/move authority: native path recognition is not a new file operation. |
| 035 | Partially replace renderer-only parser/decode/forward placement with ADR-086. Retain bounded text writes, no reads, strict content/selection/liveness and independent main validation. The existing runtime source cap is unchanged by this design decision. |
| 037–038, 040–042, 048, 069 | Retain exact candidate/CI evidence, accepted source policy and native-language registration, and contributor attribution: private facade pins do not waive verification, authorize a new language or fabricate platform evidence. |
| 047 | Retain SSH target/trust/configuration authority: terminal-host launch cannot infer or replace a project connection. |
| 049–052, 054 | Retain isolated guests, bounded terminal/header contributions, public capability boundaries and presentation tokens: extensions cannot load an engine/native host or acquire raw PTY authority. |
| 053, 055 | Retain protected agent environment and connection-scoped remote client/forward identity: native app-host parser state does not replace endpoint, host or caller authorization. |
| 056, 058–061 | Retain explicit authoring/setup/managed-delivery semantics and one-use ordinary-shell handoff: native integration cannot replay transient setup on recovery or take terminal ownership back after handoff. |
| 063, 065, 068, 070, 072, 075–078 | Retain bounded passive contributions, explicit native-program/host/session-trust decisions, action limits and setup/source grants where terminal handoff consumes them: presentation is not execution approval. |
| 085 | Retain picker-scoped SSH download and existing clipboard/drop authority: renderer pixels and native state do not supply a destination grant. |

The remaining records (004, 057, 062, 064, 066–067, 071, 073–074, 079–084) were checked for
terminal-applicable decisions. Their viewer, extension source/install/version/grant, save,
trash, sync-summary and Mermaid decisions select no terminal engine/state/presentation
mechanism; retain their own scope. Incidental use of “session” is not terminal authority.
No terminal rule is exempt because its record is cross-cutting or absent from an old list.

## Fixed comparison protocol

M15 uses the exact same clean workbench candidate with pre-start web/native selection.
Record full source and artifact hashes, full toolchain and Electron/Chromium versions, OS,
CPU/GPU/driver, display system, refresh, scale, power mode, font/fallbacks, measured cell and
pixel geometry, terminal count and workload identity. Both modes use identical settings,
build optimization, topology and inputs; do not carry prototype font adjustments. If native
and web font metrics differ, record both and match tested rows/columns, font size and pane
extent explicitly. Core/build differences are declared confounders. A native Ghostty GUI
run is a separately labeled reference, not an interchangeable hvir sample.

Use **four fresh-process pairs per primary desktop**, in fixed web/native order **AB, BA,
BA, AB** (A=web, B=native). No concurrent builds/tests, DevTools, mode switching or retries
inside a sample. Preserve all scheduled results, including failures. A process/contract
failure fails that candidate attempt; do not drop it from a timing distribution. Changed
candidate/environment or invalid instrumentation starts a separately labeled complete run.

Each process runs the same 3,000-row transcript and then continuous plain/ANSI/Unicode and
synchronized output, interactive echo, repeated resize, hidden terminal reveal, Workspace/
Sessions transitions and viewer/Git interaction under load. Retain **200** scroll events,
**200** content-tagged output updates, **100** echo events and **30** alternating resize
events, after **10** untimed warmup events of each class. Interleave workload classes in
the same fixed sequence for both modes. Use the existing capacity topology and fixture
producers; M15 extends their observation at the real presentation owner, not a second
benchmark framework. Additional high-refresh and driver configurations are separate runs.

Measure scroll dispatch→observed matching viewport frame and PTY receipt→observed matching
output frame as primary metrics. A result requires content identity plus applied geometry
and state/input sequence, using test-only frame observation at the real consumer. A send
acknowledgement, export callback or rAF alone cannot close a sample. Label the actual
observation method, sampling/readback overhead and clock conversion. Identical test-only
observation must apply to both modes. Resize starts at the actual pane/window request, before
native geometry application, and echo starts at the synthesized key dispatch; neither may
omit slow native scheduling by starting at its acknowledgement.
Do not call compositor observation physical display latency; use an external/platform display
measurement before making that claim.

Use the arithmetic mean of the middle two values for an even-sized median.
For each process/class use nearest-rank p95 (`sorted[ceil(.95*n)-1]`), retaining raw samples.
For each primary metric let `W` be the median of the four web p95s, `N` the median native
p95, and `noise = max(webP95s) - min(webP95s)`. The repeatability requirement is
`noise <= max(4 ms, .20*W)`; otherwise the run cannot establish comparative acceptance.
Improvement passes only if **both** primary metrics satisfy **`N <= .80*W`**, the median
paired improvement **`median(webP95_i - nativeP95_i) > max(2 ms, noise)`**, and **at least
three of four pairs improve**. This fixes a 20% meaningful gain and explicitly exceeds
observed baseline noise; faster feed alone cannot pass it.

For each secondary class (key dispatch→matching echo frame, resize request→matching frame,
and loaded workbench click/frame latency), define its own `Wc = median(webP95s_for_class)` and
`Dc = median(webP95_i - nativeP95_i)` using the same four pairs. No regression passes only
if **`Dc >= -max(5 ms, .10*Wc)`** for every class. Do not substitute the primary workload's
baseline. No class may fail an existing absolute capacity limit. Let
`F=1000/recordedRefreshHz`; native median p95 visible-frame gap may exceed web median p95
gap by at most **one `F`**, with no unexplained frame stall over **500 ms**. Use the actual
refresh per run, not a fixed 60-Hz assumption. Keep physical input-to-pixel observations
separately labeled if available.

Preserve the existing controlled limits: idle renderer+GPU ratio **≤1.5**, loaded/baseline
readiness p95 ratio **≤2**, readiness maximum **≤1,000 ms**, responsiveness p99 **<100 ms**,
maximum **≤500 ms**, and net working-set growth **≤256 MiB**. Include native-host CPU and
memory in whole-app process accounting; additionally report idle whole-app CPU alongside
the unchanged renderer/GPU ratio so moving work cannot hide its cost. Existing 64 KiB
delivery, retained-state and deterministic input/topology/cleanup contracts remain blocking.

Native compatibility pixels must pass exact behavior/lifetime checks and the same absolute
capacity limits; report their measurements separately and make no GPU-improvement claim.
GPU acceptance requires real native resources without routine CPU readback on macOS and at
least one actual Linux hardware desktop. Record Wayland/X11, Mesa/NVIDIA, multi-GPU, scale
and architecture coverage individually; untested combinations remain explicit. No build,
Xvfb/software run, unsupported-platform diagnostic, or CPU pixel fallback supplies that proof.
