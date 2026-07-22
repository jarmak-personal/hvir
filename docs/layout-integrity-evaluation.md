# Layout-integrity diagnostic evaluation

This document records the owner-by-owner evaluation authorized by ADR-016. It is not a
universal visual-correctness contract. hvir already prevents deterministic layout errors in
feature policy and verifies Chromium geometry where the browser is the behavior under test.
A runtime observer would need to answer a distinct diagnostic question without repeating
those owners or making layout work in order to diagnose layout.

## Evaluation boundary

The evaluated candidates are the workbench tracks and focus modes, viewer materialization,
terminal fitting, web-pane full-page mode, and platform shell geometry. A candidate qualifies
for runtime diagnostics only if its owner can expose a content-free semantic postcondition
after a natural settling event and the result is more useful than the existing policy or
focused Electron assertion.

No candidate met that bar. This evaluation adds no production observer, timer, measurement,
event schema, retained evidence, health item, or recovery behavior. Its runtime CPU, memory,
serialization, event-rate, and input/paint deltas are therefore zero by construction. The
existing #72 capacity and platform scenarios remain the performance owners; there is no
instrumentation mode to compare with their disabled baseline.

Because no runtime detector is selected, detector-only acceptance for an injected runtime
violation, event deduplication, renderer-generation rollover, cleanup, and late-measurement
rejection is not applicable. Creating an event source solely to exercise that lifecycle would
contradict the outcome of the evaluation; existing feature owners retain their current cleanup
and stale-generation tests.

## Candidate inventory

### Workbench track containment and pane modes

| Concern | Evaluation |
| --- | --- |
| Owner | `workbench-layout-policy.ts` and `split-layout-policy.ts` own the pure bounds. `useWorkbenchLayout` owns workspace restore, divider actions, and the one existing workbench `ResizeObserver`. CSS owns the restored, collapsed, terminal-focused, and tree-collapsed tracks. |
| User-observable failure | A viewer or terminal becomes unusably small, a pane escapes the workbench, or collapse/focus mode fails to hide and restore the intended surface. |
| Preconditions and trigger | The viewport can contain the declared minimum tracks. Checks follow workspace-layout restore, a workbench resize, a divider drag/nudge/reset, or an explicit pane-mode transition. A split-width guarantee requires room for two 240 px panes and the 1 px divider. |
| Threshold and tolerance | Pure policy reserves a 180 px viewer, a 160 px terminal, 240 px per split pane, and a 1 px divider. Electron interaction coverage allows 1 px for containment/restoration and 2 px for pointer-selected target sizes. |
| Severity, deduplication, and resolution | A failed assertion is a blocking conformance failure, not a runtime health verdict. Production policy clamps on the owning event; a later resize or explicit mode action naturally recomputes or restores the tracks. There is no diagnostic episode to deduplicate or resolve. |
| False positives and negatives | Pure bounds are exact under their viable-viewport precondition. DOM measurement during drag, animation, restored custom tracks, or an undersized viewport would create false positives. The focused Electron scenario can miss an untested window-manager size or scale. |
| Cost and lowest valid altitude | Direct Vitest coverage owns the calculations and workspace-qualified transient modes. The production-composed pane-divider/split scenario owns CSS Grid, pointer, keyboard, and restoration behavior. No runtime measurement is added. |
| Disposition | **#72 test-only conformance.** Do not emit product health or opt-in diagnostic evidence. |

### Viewer materialization and position continuity

| Concern | Evaluation |
| --- | --- |
| Owner | `viewer-position.ts` owns line/scroll mapping and rendered source anchors. The viewer feature and CodeMirror own asynchronous source/diff materialization, virtualization, remounting, and position capture. |
| User-observable failure | A mode change opens a blank or stale surface, loses the reading position, or restores a virtualized viewport to the wrong part of the document. |
| Preconditions and trigger | The tab and requested mode are active, the document has a scroll extent, and the new CodeMirror or rendered surface has materialized. The natural triggers are tab activation, scroll-position capture, and rendered/source/diff transitions. |
| Threshold and tolerance | Pure mappings clamp to the document. Real CodeMirror source/diff restoration keeps the first visible line within 1 line; rendered block-anchor transitions allow 4 lines because a source block, not a pixel, is the semantic anchor. The focused scenario also proves deep gutters remain virtualized rather than fully materialized. |
| Severity, deduplication, and resolution | A failed transition is a blocking viewer conformance failure. Each successful transition replaces the captured position for that tab/mode and disconnects the old surface; no long-lived runtime episode exists. |
| False positives and negatives | A runtime check would race asynchronous syntax, diff, font, and viewport materialization. Inspecting gutter DOM would couple diagnostics to CodeMirror internals, while a generic non-empty check would miss incorrect position. Focused fixtures can miss content-specific wrapping or a future renderer regression outside the exercised modes. |
| Cost and lowest valid altitude | Mapping and anchor choice stay in direct tests. Virtualization, late materialization, and remounts require the focused production-composed Electron viewer scenario on pinned Chromium; macOS runs that same scenario. No runtime reads or retained evidence are added. |
| Disposition | **#72 test-only conformance.** Reject a viewer DOM/materialization detector. |

### Terminal grid fitting and presentation

| Concern | Evaluation |
| --- | --- |
| Owner | `terminal-fit.ts` owns content-box-to-grid policy. `TerminalFitController`, behind `TerminalPane`, owns the element observer, 75 ms trailing settle, animation-frame fit, and disposal. Terminal presentation and platform scenarios own real canvas evidence. |
| User-observable failure | The final row or column is clipped, more than one cell is wasted, the PTY receives stale rows/columns, or a hidden/revealed terminal canvas fails to repaint. |
| Preconditions and trigger | The owned terminal is mounted and visible with finite positive cell metrics and a positive content box. Mount, engine readiness, the terminal element's `ResizeObserver`, reveal, split resize, and theme repaint are the owning events. |
| Threshold and tolerance | Fit floors the usable content box and retains at least 2 columns by 1 row. Platform evidence requires the canvas not to exceed its content box by more than 1 px and to leave less than 12 px horizontally and 20 px vertically—less than one cell for the pinned fixture. |
| Severity, deduplication, and resolution | A failed pure or Electron assertion blocks conformance. The controller coalesces resize notifications into one trailing fit; a later owned resize resolves stale geometry. Disposal disconnects the observer and cancels the timer/frame. No health or diagnostic lifecycle is added. |
| False positives and negatives | Runtime comparison would repeat the fit controller's computed-style and geometry reads, can observe the resize lock or hidden surface, and would still not prove the pixels are correct. The fixed-font platform fixture can miss a different font metric or GPU-rendering defect. |
| Cost and lowest valid altitude | Arithmetic stays in direct tests. Canvas bounds, real cell remainder, hidden-output pause, reveal repaint, and input belong to focused Electron/platform scenarios on Linux and macOS. No additional observer or fit is added. |
| Disposition | **#72 test-only conformance.** Keep recovery with `TerminalPane`; do not attribute a global layout fault to a terminal. |

### Web-pane full-page geometry

| Concern | Evaluation |
| --- | --- |
| Owner | `useWebPaneWorkspace` owns active/focused pane state and the exact main-process full-page authority. `App` and `web-pane.css` own workbench composition; `WebPaneSurface` keeps guest details out of product state. |
| User-observable failure | Full-page mode leaves workbench chrome interactive, clips the active guest, loses guest state, or fails to restore the prior workspace after reserved Escape. |
| Preconditions and trigger | A live, active, workspace-owned pane exists. The only triggers are the explicit **Full page** action, reserved Escape, pane/workspace deactivation, or owner revocation. |
| Threshold and tolerance | The semantic contract is exact state: full-page authority names only the focused active pane; workbench chrome is hidden and non-interactive while that state is active; Escape removes it without replacing the guest. Pixel taste or guest-page layout is outside hvir's authority. |
| Severity, deduplication, and resolution | A failed production-composed transition is a blocking web-pane conformance failure. Focus is one current pane ID rather than an event stream, so repeated state is naturally idempotent; Escape, deactivation, close, or renderer revocation resolves it. |
| False positives and negatives | A renderer detector that inspects guest/workbench rectangles would depend on toolbar, CSS, and `<webview>` timing and could force layout. Checking only the focus class would restate React state without proving geometry. The existing scenario can miss page-authored visual defects, which are intentionally not hvir layout faults. |
| Cost and lowest valid altitude | The real Electron web-pane workflow already proves explicit entry, guest-state preservation across workspace switches, reserved-Escape recovery, and later close/revocation. Generic Chromium behavior is not promoted into a macOS-specific claim. No runtime work is added. |
| Disposition | **#72 test-only conformance.** Reject both guest observation and a workbench-wide full-page detector. |

### Platform shell geometry

| Concern | Evaluation |
| --- | --- |
| Owner | Shell/workbench CSS owns the initial grid. `platform-contracts.ts` owns the real Electron snapshot and assertions; it does not feed product diagnostics. |
| User-observable failure | The workbench or terminal extends beyond the content viewport, the default terminal is too short to be useful, the real canvas is clipped, or the installed runtime changes protocol/platform behavior. |
| Preconditions and trigger | The smoke window is 1280×800 and the automatically launched PTY, terminal host, canvas, divider, and workbench have reached semantic readiness. The check runs once per fresh platform scenario, never periodically in product. |
| Threshold and tolerance | Workbench and terminal bounds remain within 1 px of the content viewport. Default terminal height follows the declared 3.8:4 share with a 260–325 px useful bound. Canvas remainder uses the terminal-fit limits above. |
| Severity, deduplication, and resolution | A failed Linux or macOS scenario blocks conformance for that platform. A fresh hermetic scenario is the lifecycle; there is no runtime grouping or recovery policy. |
| False positives and negatives | The fixed window cannot prove every monitor, scale factor, or window-manager configuration. Conversely, treating a transient live resize as failure would be noisy. Platform-specific evidence must come from that platform, so macOS contracts run on macOS ARM64 rather than being inferred from Linux. |
| Cost and lowest valid altitude | Production-composed Electron is the lowest valid altitude for viewport, canvas, native PTY, and protocol geometry. The named Linux and macOS scenarios already provide it; no application instrumentation is added. |
| Disposition | **#72 platform conformance.** Do not create a packaged geometry monitor. |

## Decision

Assign all five candidates to feature-owned pure tests or focused #72 Electron conformance.
Promote none to opt-in diagnostics and none to always-on workbench health. Consequently there
is no layout event schema, rate limit, report field, deterministic runtime fault fixture, or
promotion issue to add. Existing test fixtures already inject invalid policy inputs and perform
the real enter/settle/restore transitions at the altitude that owns them; those assertions fail
the test directly instead of manufacturing product evidence.

This decision deliberately rejects periodic DOM walks, global mutation observation, screenshot
comparison, forced synchronous measurement sweeps, generic rectangle oracles, and selectors in
production diagnostics. Reconsider one candidate only from a separately aligned, concrete
user-visible failure that escapes its owner coverage and can expose a stable semantic
postcondition without measuring incidental markup.
