# ADR-018: Script-free first-use native payload preparation

## Context

ADR-011 gives hvir one npm installation surface backed by platform-selected native payloads.
Those payloads cannot be represented as ordinary expanded npm package files on macOS because npm
packing and extraction omit the Electron framework symlinks. The original payload package
therefore carried an archive and expanded it through `postinstall`.

npm's install-script approval policy makes a dependency lifecycle script either a security
warning or blocked work during a global install. A published dependency cannot approve itself,
and requiring a CLI flag or persistent user configuration would break the one-command contract.
Expansion also cannot move to the installed package directory at launch because a global npm
prefix may correctly be read-only to the invoking user.

## Decision

This record refines ADR-011. Every supported platform payload remains one npm-integrity-checked
archive and declares no install-time lifecycle script. Linux and macOS use the same preparation
lifecycle; platform differences remain validation details.

On the first explicit `hvir` launch for a version, the public launcher reads the selected payload
from the npm prefix and prepares it in the invoking user's cache:

- `$XDG_CACHE_HOME/hvir/native`, falling back to `~/.cache/hvir/native`, on Linux; and
- `~/Library/Caches/hvir/native` on macOS.

Preparation verifies the archive checksum recorded in the platform metadata, extracts into a
unique staging directory, validates the executable, writes a completion marker, and atomically
renames the complete directory into its versioned location. A cache-local owner lock serializes
preparation; waiters reuse the completed result, and a later launch recovers a dead owner or an
ownerless interrupted lock and removes abandoned staging. The launcher reports first-use and wait
progress before the application exists to paint. Subsequent launches validate the completion
marker and executable without repeating extraction.

After successful preparation, the cache retains the current and immediately previous completed
payload for that platform package and removes older completed versions. Failed staging is removed
on failure or the next preparation. Because script-free npm uninstall cannot mutate a user's
cache, uninstall may leave that bounded two-version residue; a later hvir version prunes it, and
the documented cache root is safe for the user to remove when hvir is not running.

The launcher never writes to the npm prefix, downloads another payload, compiles source, or
elevates privileges. Whether `npm install -g` itself may write the configured global prefix
remains npm and user-environment policy; hvir neither invokes nor recommends `sudo`. Archive
preparation preserves the bytes, framework links, signing, and notarization state produced by the
native release build.

## Consequences

Fresh installs work when dependency scripts are blocked and launches work from read-only global
prefixes. All three release targets share one recovery, concurrency, update, cleanup, and smoke
contract. First launch pays a visible checksum and extraction cost, and the installed archive plus
up to two prepared versions increases disk use. Uninstall residue cannot be removed automatically
without reintroducing an install lifecycle or another privileged installer surface.

The cache is derived release material, not a second update authority. npm continues to own
platform selection, exact version installation, integrity, caching, and provenance; the launcher
accepts only its matching installed platform package.

## Rejected alternatives

- Approving hvir's own script through npm flags or persistent user configuration; a dependency
  cannot grant that trust and the requirement would break the supported install command.
- Shipping Linux expanded while deferring only macOS extraction; this saves one Linux first-use
  step but creates two installation, update, cleanup, and acceptance lifecycles without product
  evidence that the divergence is necessary.
- Expanding into the global npm prefix on first launch; valid read-only prefixes would require
  elevation.
- Downloading or compiling a payload on first launch; either would bypass npm's integrity and
  provenance boundary and contradict ADR-011.
- Adding a native installer or in-application updater; both widen the supported distribution
  surface beyond hvir's product boundary.
