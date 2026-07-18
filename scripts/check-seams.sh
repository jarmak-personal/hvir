#!/usr/bin/env bash
#
# Grep-level enforcement of the architectural seams (AGENTS.md "Respect the
# seams"). This is a coarse backstop that complements the precise ESLint rules
# in eslint.config.mjs — it catches a violation even if lint is skipped, and
# documents the invariants in one readable place.
#
set -uo pipefail

fail=0
SRC="src"

report() {
  # $1 = human description, $2 = matching lines (empty = ok)
  if [[ -n "$2" ]]; then
    printf '\033[31m✗ %s\033[0m\n' "$1"
    printf '%s\n' "$2" | sed 's/^/    /'
    fail=1
  else
    printf '\033[32m✓ %s\033[0m\n' "$1"
  fi
}

# 1. ipcRenderer only in the preload bridge.
hits=$(grep -rnw 'ipcRenderer' "$SRC" --include='*.ts' --include='*.tsx' \
  | grep -v '^src/preload/' || true)
report "ipcRenderer used only in src/preload/" "$hits"

# 2. Host primitives (fs / child_process / chokidar / node-pty) only in LocalHost.
hits=$(grep -rnE "from ['\"](node:)?(fs|fs/promises|child_process)['\"]|from ['\"](chokidar|node-pty)['\"]|import\(['\"]((node:)?(fs|fs/promises|child_process)|chokidar|node-pty)['\"]\)" \
  "$SRC" --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/project-host/local-host.ts' || true)
report "host primitives imported only in local-host.ts" "$hits"

# 3. PTY spawning (host.spawnPty call sites) only in the supervisor.
hits=$(grep -rnE '\.spawnPty\(' "$SRC" --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/pty/pty-supervisor.ts' || true)
report "host.spawnPty() called only in pty-supervisor.ts" "$hits"

# 4. Bundled harness identities stay inside provider-owned main modules. Shared
# IPC, persistence, and renderer code treat provider ids as opaque catalog data.
hits=$(grep -rnE "['\"](plain-shell|claude-code|codex)['\"]" \
  "$SRC" --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/harness/' || true)
report "bundled harness ids used only in src/main/harness/" "$hits"

# 5. Raw loopback streams are transport for the main-owned pane proxy, never a
# renderer, IPC, harness, or feature-level socket API.
hits=$(grep -rnE '\.connectLoopback\(' "$SRC" --include='*.ts' --include='*.tsx' \
  | grep -v '^src/main/web-pane/loopback-http-proxy.ts' || true)
report "host.connectLoopback() called only in the web-pane proxy" "$hits"

if [[ "$fail" -ne 0 ]]; then
  printf '\n\033[31mseam check failed\033[0m\n'
  exit 1
fi
printf '\nseam check passed\n'
