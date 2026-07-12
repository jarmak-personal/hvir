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
- [ ] Scaffold with `electron-vite` + React + TypeScript (strict mode). Verify current
      scaffold command against electron-vite docs.
- [ ] Repo layout: `src/main/` (main process), `src/renderer/` (React),
      `src/workers/` (utility processes), `src/shared/` (types + IPC contracts,
      importable by all).
- [ ] npm scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test` (vitest).
- [ ] ESLint + Prettier configured; CI-runnable via `npm run lint && npm run typecheck && npm test`.

### Core types (src/shared)
- [ ] `HostPath` — the `(hostId, path)` pair. Make it the only way paths move through
      the app: a branded/opaque type so a bare `string` path is a type error at
      boundaries.
- [ ] Typed IPC contract: one module defining every channel name + request/response
      types, shared by main and renderer. No stringly-typed `ipcRenderer.send` calls
      outside it.

### The four seams (interfaces + local implementations/stubs)
- [ ] **`ProjectHost`** interface (ADR-010): `exec` (buffered + streaming),
      `spawnPty`, `readFile`, `writeFile`, `readdir`, `stat`, `watch` (returns a
      disposer), `hostId`, lifecycle (connect/dispose). Design the shape; exact
      signatures are yours to finalize.
- [ ] **`LocalHost`** implementing `ProjectHost` with node:fs, child_process, chokidar,
      node-pty. Unit-test read/write/list/exec/watch against a temp dir.
- [ ] **PTY supervisor** (ADR-006): the single module through which every PTY is
      spawned (delegating to a `ProjectHost.spawnPty`). Owns the PTY registry,
      attach/detach of renderer streams, and exit events. Nothing else may spawn a PTY.
- [ ] **`HarnessAdapter`** interface (ADR-006): launch command + args (including
      pre-assigned session id), resume command, title conventions. Stub only — real
      adapters land in Phase 6. Include a `plainShell` adapter (no session semantics).
- [ ] **`TerminalPane`** interface (ADR-003): mount/dispose, write/onData, resize,
      title/bell/OSC event callbacks. Stub only — implementation lands in Phase 2.

### Enforcement
- [ ] ESLint restriction: `node:fs`, `child_process`, `chokidar`, `node-pty` importable
      **only** inside the `LocalHost` module; PTY spawning importable only inside the
      supervisor. This mechanically enforces the seams.
- [ ] Utility-process harness: a helper to launch a `src/workers/` module as an Electron
      utility process with the typed IPC contract. Prove it with a trivial echo worker.

## Acceptance criteria
- [ ] `npm run dev` opens an empty window; `npm run build` produces a runnable app on Linux.
- [ ] `LocalHost` unit tests pass, including watch events on a temp dir.
- [ ] A demo utility process round-trips a typed IPC message.
- [ ] Grep test: no `ipcRenderer` usage outside the IPC contract module; no `node:fs`
      import outside `LocalHost`; lint enforces both.
- [ ] Status table in `00-overview.md` updated.

## Non-goals
File tree, viewer, terminal UI (Phase 2). SshHost (Phase 4). Real harness adapters
(Phase 6). Any styling beyond a blank window.
