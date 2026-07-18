# ADR-001: Electron as the shell

## Context

hvir needs a cross-platform desktop shell with mature support for application chrome,
panes, terminal canvases, isolated web content, and native process integration. Product
speed and access to proven components matter more than minimizing the shell's baseline
memory footprint.

## Decision

Build hvir on Electron. Linux and modern macOS are the primary platforms. Achieve a
light, responsive feel by moving expensive filesystem, Git, parsing, and rendering work
off the render thread rather than by choosing a smaller shell.

## Consequences

hvir accepts Electron's memory and distribution costs in exchange for Chromium behavior,
Node integration in privileged processes, mature packaging, and a broad component
ecosystem. Electron and Chromium lifecycle and security behavior require real integration
coverage in addition to unit tests.

## Rejected alternatives

- Tauri reduces baseline memory, but system-webview differences make terminal-canvas and
  embedded-content behavior less predictable across targets.
- A native or GPUI shell would require substantially more product infrastructure and cut
  against the preference for mature open-source components.
