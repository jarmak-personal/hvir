# Phase 1 — Scaffold & core seams

**Read first:** [`00-overview.md`](00-overview.md); design.md §3 (principles), §5
(architecture), ADR-001/002 (Electron, electron-vite + React), ADR-006 (PTY supervisor,
`HarnessAdapter`), ADR-010 (`ProjectHost`, host-qualified paths).

## Goal

A running Electron shell with the process model and **all four seams defined in code**
before any feature exists. The seams are the durable skeleton — every later phase plugs
into them. No visible features ship in this phase beyond an empty window.

## Tasks

### Project scaffold
- [x] Scaffold with `electron-vite` + React + TypeScript (strict mode). Verify current
      scaffold command against electron-vite docs.
      → Scaffolded manually (not via `create-electron`) for full control over the
      four-directory layout and seam enforcement. Versions verified against the live
      registry: the "latest of everything" set is *incoherent* (typescript-eslint
      requires TS `<6.1`, electron-vite requires vite `^7`), so pinned a coherent set:
      electron 43, electron-vite 5, vite 7, React 19, TS 5.9, typescript-eslint 8.
- [x] Repo layout: `src/main/` (main process), `src/renderer/` (React),
      `src/workers/` (utility processes), `src/shared/` (types + IPC contracts,
      importable by all).
- [x] npm scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test` (vitest).
      (plus `check-seams`, `verify`, `smoke`.)
- [x] ESLint + Prettier configured; CI-runnable via `npm run lint && npm run typecheck && npm test`.

### Core types (src/shared)
- [x] `HostPath` — the `(hostId, path)` pair. Make it the only way paths move through
      the app: a branded/opaque type so a bare `string` path is a type error at
      boundaries. → `src/shared/host-path.ts`, opaque via a phantom brand; the single
      constructor `hostPath()` normalizes. Helpers: join/dirname/basename/equals/display.
- [x] Typed IPC contract: one module defining every channel name + request/response
      types, shared by main and renderer. No stringly-typed `ipcRenderer.send` calls
      outside it. → `src/shared/ipc.ts` (`IpcInvokeMap` + `INVOKE_CHANNELS` allow-list);
      `ipcRenderer` is confined to the preload bridge by lint.

### The four seams (interfaces + local implementations/stubs)
- [x] **`ProjectHost`** interface (ADR-010): `exec` (buffered + streaming),
      `spawnPty`, `readFile`, `writeFile`, `readdir`, `stat`, `watch` (returns a
      disposer), `hostId`, lifecycle (connect/dispose). → `src/main/project-host/`.
      `spawnPty` is async (fits remote hosts + lazy native load).
- [x] **`LocalHost`** implementing `ProjectHost` with node:fs, child_process, chokidar,
      node-pty. Unit-test read/write/list/exec/watch against a temp dir. → node-pty is
      lazily imported inside `spawnPty` so dev/tests need no Electron-ABI rebuild yet.
      11 `LocalHost` unit tests pass, incl. buffered/streaming exec, EOF handling,
      symlink stat, watch, and foreign-host rejection.
- [x] **PTY supervisor** (ADR-006): the single module through which every PTY is
      spawned (delegating to a `ProjectHost.spawnPty`). Owns the PTY registry,
      attach/detach of renderer streams, and exit events. Nothing else may spawn a PTY.
      → `src/main/pty/pty-supervisor.ts`; sole caller of `.spawnPty` (lint-enforced).
      Supervisor tests cover stream attachment, active/pending duplicate-session
      rejection, exit cleanup, and deterministic resume.
- [x] **`HarnessAdapter`** interface (ADR-006): launch command + args (including
      pre-assigned session id), resume command, title conventions. Stub only — real
      adapters land in Phase 6. Include a `plainShell` adapter (no session semantics).
      → `src/main/harness/harness-adapter.ts`.
- [x] **`TerminalPane`** interface (ADR-003): mount/dispose, write/onData, resize,
      title/bell/OSC event callbacks. Stub only — implementation lands in Phase 2.
      → `src/renderer/src/terminal/terminal-pane.ts` (throwing stub factory).

### Enforcement
- [x] ESLint restriction: `node:fs`, `child_process`, `chokidar`, `node-pty` importable
      **only** inside the `LocalHost` module; PTY spawning importable only inside the
      supervisor. This mechanically enforces the seams. → `eslint.config.mjs`
      (`no-restricted-imports` + a `no-restricted-syntax` rule banning `.spawnPty()`
      calls outside the supervisor).
- [x] Utility-process harness: a helper to launch a `src/workers/` module as an Electron
      utility process with the typed IPC contract. Prove it with a trivial echo worker.
      → `src/main/worker-host.ts` + `src/workers/echo-worker.ts`.
      The worker client is generic over a request/response protocol map, so arbitrary
      message names, payloads, and result casts are compile-time errors.

## Acceptance criteria
- [x] `npm run dev` opens an empty window; `npm run build` produces a runnable app on Linux.
      → `build` verified (main+preload+renderer+worker bundles). Window paint verified
      under `xvfb-run` via `HVIR_SMOKE=1` (`window ready-to-show OK`), with the renderer
      round-tripping `app:info` back through the real IPC handler. (This box's machine is
      headless with no GPU, so verification runs under Xvfb; on a real desktop
      `npm run dev` opens the window directly.)
- [x] `LocalHost` unit tests pass, including watch events on a temp dir. → 11
      `LocalHost` tests green; 20 tests across the Phase 1 suite.
- [x] A demo utility process round-trips a typed IPC message. → verified in the real
      Electron runtime via `HVIR_SMOKE=1` (renderer → preload → main → echo worker →
      renderer, with the off-main PID confirmed).
- [x] Grep test: no `ipcRenderer` usage outside the preload bridge; no `node:fs`
      import outside `LocalHost`; lint enforces both. → `scripts/check-seams.sh` + lint,
      including dynamic-import and aliased `spawnPty` access protection.
- [x] Status table in `00-overview.md` updated.

## Non-goals
File tree, viewer, terminal UI (Phase 2). SshHost (Phase 4). Real harness adapters
(Phase 6). Any styling beyond a blank window.
