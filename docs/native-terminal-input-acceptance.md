# Native terminal input acceptance

Use the native development build and bindings described in
[native-terminal.md](native-terminal.md#development-workbench-runtime). The library,
headers and bindings must come from the same pinned build. These checks use the
existing sandboxed workbench and PTY supervisor; they do not qualify Linux GPU
hardware, controlled performance, or an installed release.

Run the existing opt-in workbench scenario:

```sh
HVIR_NATIVE_TERMINAL_LIBRARY=/absolute/path/to/libghostty.dylib npm run smoke:native-terminal
```

On Linux use the corresponding `.so` and the existing device/presentation/Ozone
controls in the development instructions. Software compatibility and hardware
DMA-BUF results remain distinct.

The input qualifier launches its bounded recorder inside the workbench's existing
shell/PTY, returns to that shell, and preserves the original resize/`stty` and exit
checks. It checks real Chromium key events, native Enter/control/Alt/Meta/arrows,
DECCKM, Kitty repeat/release, modifyOtherKeys, LNM, SGR mouse drag/wheel, and focus
reports against exact byte counts and hashes. A small synthetic ClipboardEvent
checks Unicode/CRLF paste, native control sanitization, bracketed framing and one
complete user write without reading or writing the system clipboard. This does not
qualify large-paste admission or establish an ordinary-paste source ceiling.

A parser status reply and a user key also share a source-admitted output prefix: the recorder checks reply-before-key
wire order and the observer counts the user write separately. Browser latency can
allow the reply to finish first; this is not a claim of physical simultaneity.

A bounded continuous-output phase starts one stdout producer inside that same raw
recorder. It uses short-line CR+EL overwrites, honors stdout backpressure, emits at
least 64 KiB of wire body before its input trigger,
and stops on Ctrl-C or its fixed byte/time bound. The source-admission observer
triggers real Chromium Ctrl-C; the recorder
requires byte `03` while production is still active, with one confirmed user write.
Receipts retain only produced/admitted counts, not output bodies. This checks control
progress under active TUI-style overwrite output, not a scrollback flood, OS SIGINT
or physical simultaneity. Short-line updates preserve original markers and keep the
existing bounded retained-read observer usable without increasing its limit. The pending
source-batch mode race remains covered by the actual ingress/scheduler tests plus
separate real native DECCKM byte checks; the UI phase does not force that race.

Composition events in this automated scenario are programmatic Chromium DOM
transactions. Preedit has its own native snapshot check before commit. Completion
serials are checked against native IO application and a subsequently rebuilt native
frame; ordinary key checks use an explicit recorder output marker to request fresh
content. Those serial checks alone do not establish pixel content or physical paint.
The finished-terminal scroll check separately compares captured pixels after hiding
the cursor and observing a stable baseline. Captures stay in memory; the receipt
contains bounded flags and numbers, not screenshots or input/transcript bodies.

## Manual OS input methods and layouts

Start the ordinary native development workbench and open a disposable shell pane.
Keep the native library, bindings and app revision together. Record platform, desktop
session, input-method name/version and keyboard layout without recording typed text.

1. Focus the terminal through the keyboard and by clicking. Type ordinary text,
   Unicode and punctuation using the active non-US layout. Check Shift, AltGr,
   dead-key accents, keypad navigation, repeat and release in a terminal application.
   Reserved workbench shortcuts must still act on the workbench once.
2. With a configured OS IME, start composing several characters. Check that the
   native preedit remains visible and the candidate window follows the caret.
   Commit once, then type another character: neither the preedit nor the committed
   body should be duplicated or disappear.
3. Cancel composition, then type normally. Repeat while changing pane width, moving
   the window between displays with different scale, and switching away/back during
   composition. No old composition or key release should reach a replacement pane.
4. Test ordinary text paste and the existing Ctrl-V/Ctrl-Alt-V image-paste/fallback
   gesture. Provider-prepared paste keeps its existing main-owned behavior. A new
   paste-size refusal is not established by this recipe.
5. Use a TUI with application mouse reporting, then a normal shell with scrollback.
   Check wheel/trackpad direction, drag, release outside the pane, and focus transfer.
   Exit the shell and confirm its retained history still scrolls without new writes.

`KeyboardLayoutMap` is optional. Cached alternate-layout metadata requires callable
layout lookup and event-listener methods plus a declared layout-change signal.
Electron's lookup-only keyboard object does not meet that freshness contract: the
adapter uses observed character information and leaves unverifiable alternate
characters unknown. Observed text wins over mismatched cached metadata; changes
invalidate the cache before a new lookup completes. It does not assume a US
character from a physical key label. Confirm actual layout behavior manually.
Programmatic composition does not replace OS IME checks, and this milestone does
not claim selection/copy/search acceptance.

The workbench qualification also contains two synthetic large-paste transactions on
its existing PTY: exactly 17 MiB of UTF8 Unicode/CRLF input and exactly 33 MiB of LF
input with native LNM enabled and bracketed paste explicitly disabled (66 MiB wire
bytes); the Unicode/CRLF case retains native bracketed framing (+12 bytes). The
renderer generates each input locally; only a compact recorder program crosses the
shell. The recorder hashes bytes incrementally, and acceptance requires its exact
count/hash plus one complete confirmed user write. These cases exercise the ordinary
paste path beyond the rejected source ceiling and the ordinary concurrent result
budget; they do not establish an upper paste-size limit. The original sixteen input
phases remain separate in the receipt. Only a successful actual run may claim large
admission qualification.

Renderer RAF gaps retain the existing responsiveness budget. Electron process memory
and renderer heap measurements are sampled observations, with units and unavailable
fields preserved; result-capacity credits are not a physical-memory or peak-working-set
bound. Synthetic clipboard events do not qualify system clipboard integration.

## Native selection and explicit copy

The same opt-in workbench scenario also runs a synthetic selection recorder inside
its existing Shell PTY. Real Chromium pointer events exercise drag, word/line
selection, Unicode/wide/combining characters, explicit whitespace, soft wraps,
Select All, the context menu, Meta+C and Ctrl+Shift+C. Plain Ctrl+C remains terminal
input. Copy goldens come from fixed fixture data, rather than an observed selection.
An unrelated-row producer honors stdout backpressure and emits at least 64 KiB before
the live drag/copy phase. A larger copy checks actual later Ctrl+C progress or a
truthful stale refusal after that input causes selected output to change.

The qualifier intentionally tests Clear Screen and Scrollback and Reset Terminal.
It first verifies the original retained marker, then starts a new, explicitly named
retention epoch. The later paste, resize and final-exit checks preserve that new
marker. Known colored history and a fixed final marker keep the finished-terminal
scroll/selection checks independent from shell prompt formatting.

Local runs intercept the browser's clipboard write call and retain only byte counts
and SHA-256 values; they do not modify the machine's clipboard. The explicit
`HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD=1` qualification flag is reserved for the
Linux CI scenario's disposable Xvfb display, where the actual browser write is read
back through Electron's clipboard owner. Receipts distinguish those modes. This is
not primary-selection or middle-click paste support.

Synthetic OSC8/file and plain-path links retain the originating host. A dedicated
HTTP fixture listens only on `127.0.0.1` with an ephemeral port for the real loopback
web-pane route; the qualifier closes its pane and server. External-link activation
is observed at the existing browser opener without launching an OS application.
These software checks do not qualify hardware GPU presentation, manual OS clipboard
formats, SSH/provider-specific image staging, physical paint, or OS input methods.
