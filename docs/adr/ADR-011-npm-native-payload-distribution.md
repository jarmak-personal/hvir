# ADR-011: One npm launcher with native payloads

## Context

hvir needs one install, update, and removal story while Electron and `node-pty` payloads
must be built and exercised on their target architecture. Supporting several installer
formats would multiply release and support paths.

## Decision

The supported installation contract is `npm install -g hvir-workbench`, followed by
`hvir`. The public launcher selects an integrity-checked optional payload package for
Linux x64, Linux arm64, or macOS arm64. Each payload contains an unpacked application
built for its native architecture and expands without compiling on the user's machine.

Intel macOS, Windows, dmg, zip, AppImage, and deb are not release targets.

## Consequences

Users get one familiar installation surface, while npm owns platform selection, version
matching, caching, integrity, and provenance. Native release workers remain necessary.
The hidden payload packages are release mechanics, not distinct products.

## Rejected alternatives

- Maintaining native installers alongside npm.
- Publishing source and compiling Electron or native dependencies during user install.
- Shipping one universal package containing every platform.
- Downloading payloads from a separate host in `postinstall`.
- Expanding the supported hardware and operating-system matrix without product evidence.
