# Dependency patches

`ghostty-web+0.4.0.patch` replaces ghostty-web's perpetual per-terminal render loop with
one-shot, coalesced presentation frames and exposes a pause/resume lifecycle to the concrete
terminal adapter. Hidden panes continue parsing the single live WASM terminal buffer.

This is a bounded bridge, not a fork. Issue #67 owns removal: when the next stable
ghostty-web release is evaluated, drop the patch if upstream provides an equivalent
demand-driven renderer and presentation lifecycle, then rerun the terminal lifecycle and
capacity evidence from #125.
