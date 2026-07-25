# Dependency patches

`ghostty-web+0.4.0.patch` replaces ghostty-web's perpetual per-terminal render loop with
one-shot, coalesced presentation frames and exposes a pause/resume lifecycle to the concrete
terminal adapter. It also lets the adapter make the blinking cursor visible and restart its
cadence when user input arrives, so cursor motion is painted continuously instead of moving
during an intentionally hidden blink phase. Hidden panes continue parsing the single live WASM
terminal buffer. The patch also replaces the embedded WASM payload and exposes soft-wrap state
for scrollback rows so hvir's terminal link provider can preserve logical lines after they leave
the active screen.

The embedded payload is built from the Ghostty submodule at
`5714ed07a1012573261b7b7e3ed2add9c1504496` in `coder/ghostty-web` tag `v0.4.0`. Apply that
release's `patches/ghostty-wasm-api.patch`, then
`git apply --unidiff-zero ghostty-wasm-scrollback-wrap.diff`, and build with Zig 0.15.2:

```sh
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
```

The embedded artifact's SHA-256 is
`ae0ec7f5c0f36b1c5df9d24b2cff11a624ecedf0059d19b3ed1be49f783ddaab`.

This is a bounded bridge, not a fork. Issue #67 owns removal: when the next stable
ghostty-web release is evaluated, drop the patch if upstream provides an equivalent
demand-driven renderer, presentation lifecycle, and scrollback wrap API, then rerun the terminal
lifecycle and capacity evidence from #125 and #263.
