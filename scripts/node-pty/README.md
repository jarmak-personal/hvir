# Pinned node-pty Unix exit drain correction

The dependency remains Microsoft's MIT-licensed `node-pty` 1.1.0, published at
<https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz>. `pin.json` records that
archive's existing npm-lock integrity, both exact published inputs, both patched
outputs, and the unified patch digest. Upstream copyright/license notices remain
in the package. No native source or binary changes are part of this patch.

The published Unix implementation starts a 200 ms socket-destruction workaround
when its native child-exit callback runs. Destroying a deliberately paused read
stream can discard unread final output. The patch keeps the same 200 ms workaround
for **unpaused idle** reads, cancels it during pause, rearms it on resume/data
progress, and removes its scoped listeners/timer on close. It does not resume a
consumer forcibly, buffer output, or increase the timeout. Public exit continues
to follow stream close, allowing the existing supervisor to settle admitted output.

An explicit physical-exit flag prevents `kill()` from signalling an already-reaped
PID while public exit awaits drain. In that case explicit termination closes only
the owned stream and pending write immediate. Destroying a live stream still
signals its live child through the existing path.

`exit-drain.patch.txt` is a genuine change to the dependency's
`src/unixTerminal.ts` and its corresponding shipped `lib/unixTerminal.js`; it is
not an alternate location for hvir implementation. The runtime dependency-install
owner runs `node scripts/node-pty/apply.mjs` before its existing native rebuilds.
The installer accepts only the exact original pair or exact already-patched pair,
checks the dependency/lock identity and patch digest, applies with `git apply`
without fuzzy matching, verifies both outputs, and rejects unknown/mixed/linked
inputs. Updating node-pty requires deliberately refreshing this reproduction
artifact and its qualification; no generic patch registry is introduced.

Tests execute the installed Unix implementation with controlled immediate fork,
TTY and clock dependencies. The existing `pty-native` Electron smoke group also
runs the real Supervisor/LocalHost transport with baseline, fast, 500 ms delayed
tail, and streamed output above 1 MiB. It checks exact counts/hashes/final markers,
owned child exit, and serial bounded consumer work. These are transport proofs,
not native GPU or controlled-capacity qualification. Existing ingress-owner tests
separately enforce 128 KiB per-session / 1 MiB aggregate physical admission credit.
