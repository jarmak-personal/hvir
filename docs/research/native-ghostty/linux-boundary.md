# Linux native presentation boundary after libghostty-vt 1.0.1

The #1094 study supports proceeding with the production migration **conditionally**.
Its live interaction and resize evidence is macOS-only. No Linux terminal, native
library execution, DMA-BUF import, or driver/display combination has been qualified.
The refreshed #1090 plan authorizes implementation without waiting for a maintainer
Linux run; it does not waive the later Linux acceptance gates.

## What changed, and what did not

The production reassessment candidate is full Ghostty source
`108cacb17ed8990840cd14abfce43d8ed8503ca1`, corresponding to libghostty-vt 1.0.1.
This is source inspection, not a rerun of the existing experiment. The demonstrated
macOS library, patch set, timings, and live probes remain pinned to Ghostty 1.4.0
`83fb95624b0439ee660c2679b43b38c8b63769cd` with Zig 0.17.0. No existing result is
attributed to the newer source.

The stable VT API does not include GPU rendering. A full renderer integration still
needs a private embedding boundary. At the exact reassessment source:

| Source seam | Observed boundary | Required proof |
| --- | --- | --- |
| [`apprt/embedded.zig`](https://github.com/ghostty-org/ghostty/blob/108cacb17ed8990840cd14abfce43d8ed8503ca1/src/apprt/embedded.zig) | `Platform` and `PlatformTag` expose macOS and iOS only. There is no supported Linux surface configuration. | Create a Linux embedded surface with an owned EGL device/context and explicit teardown. Adding a numeric platform tag alone cannot supply this. |
| [`termio/backend.zig`](https://github.com/ghostty-org/ghostty/blob/108cacb17ed8990840cd14abfce43d8ed8503ca1/src/termio/backend.zig) | The backend union still contains only Exec. | Feed the externally owned PTY without an extra shell/PTY and acknowledge applied parser geometry before external resize notification. |
| [`renderer/OpenGL.zig`](https://github.com/ghostty-org/ghostty/blob/108cacb17ed8990840cd14abfce43d8ed8503ca1/src/renderer/OpenGL.zig) | OpenGL 4.3 is required. A healthy presentation path attempts DMA-BUF export; failure falls back to CPU pixels. | Detect actual export/import support. Record GPU versus compatibility presentation separately; a returned frame alone does not prove the GPU route. |
| [`renderer/opengl/Frame.zig`](https://github.com/ghostty-org/ghostty/blob/108cacb17ed8990840cd14abfce43d8ed8503ca1/src/renderer/opengl/Frame.zig) | Completion calls `gl.finish()` before pushing the exported frame. | Keep that wait off UI threads and lease resources until both producer completion and consumer release. |
| [`renderer/Dmabuf.zig`](https://github.com/ghostty-org/ghostty/blob/108cacb17ed8990840cd14abfce43d8ed8503ca1/src/renderer/Dmabuf.zig) | Frames carry fourcc, modifier, premultiplication, and up to four owned plane FDs with offsets/strides; disposal closes descriptors. | Transfer actual descriptor references across the selected process boundary, validate metadata, and close each owned reference on success and every failure path. An integer in IPC is not descriptor transfer. |

These are bounded production proof obligations, not a claim that the required
patches have been written or that all drivers can export/import the chosen format.

## Available environment and reproduction

The reassessment host is Darwin arm64. A fresh `docker info` attempt could not reach
the local daemon. The installed `zig version` reports 0.16.0; the selected source requires 0.17.0.
No authorized disposable Linux/SSH target or Linux desktop result
was supplied. A container or Xvfb result would still not qualify real hardware GPU
presentation. No remote host was selected from ambient SSH configuration.

The [existing Linux command](live-study.md#linux-and-ssh) is retained as a pinned
1.4.0 build/load/platform-boundary diagnostic. It has no Linux renderer facade or
Electron importer, intentionally probes an unsupported platform tag, and exits
nonzero even if that known boundary is confirmed. It is **not** a runnable Linux
terminal and should not be offered as the desktop scrolling acceptance command.

## Completion and later gates

This study can close with its macOS evidence and explicit Linux limitation. The
production [external facade (#1110)](https://github.com/jarmak-personal/hvir/issues/1110)
owns removal of the idle backend. The
[native host (#1111)](https://github.com/jarmak-personal/hvir/issues/1111) must prove
actual resource transfer before a platform adapter relies on it. The
[Linux presenter (#1113)](https://github.com/jarmak-personal/hvir/issues/1113) must
provide a pushed, reproducible interactive GPU terminal and retain hardware evidence;
the missing rendered-path qualification must be resolved before its GPU acceptance,
not used to prevent implementing the code needed to obtain that evidence. This
diagnostic supplies no rendered-path proof. The
[full workbench qualification (#1122)](https://github.com/jarmak-personal/hvir/issues/1122)
requires real Linux GPU/manual results before Linux adoption.

Mesa/NVIDIA, Wayland/X11, multi-GPU, fractional scaling, descriptor lifetime under
consumer loss, and package/ABI compatibility remain unqualified. Source support,
a compile, a successful app initialization, and macOS smoothness are not substitute
proof for any of them.
