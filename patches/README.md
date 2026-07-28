# Dependency patches

`ghostty-web+0.4.0.patch` applies to the exact
[`hvir-v0.4.0-1`](https://github.com/jarmak-personal/ghostty-web/releases/tag/hvir-v0.4.0-1)
compatibility-fork artifact pinned in `package.json` and `package-lock.json`. It replaces
ghostty-web's perpetual per-terminal render loop with one-shot, coalesced presentation frames
and exposes a pause/resume lifecycle to the concrete terminal adapter. It also lets the adapter
make the blinking cursor visible and restart its cadence when user input arrives, so cursor
motion is painted continuously instead of moving during an intentionally hidden blink phase.
Hidden panes continue parsing the single live WASM terminal buffer. The patch also gives custom
link providers priority over built-ins, allowing hvir to replace global `window.open` activation
with its typed file and loopback-web routing without changing Ghostty's built-in provider order.

The dependency fork and this hvir-side patch are bounded compatibility bridges. Issue #67 owns
their removal: when the next stable upstream ghostty-web release is evaluated, replace the fork
artifact and drop the patch if upstream provides an equivalent demand-driven renderer and
presentation lifecycle, then rerun the terminal lifecycle and capacity evidence from #125.
