# hvir-agent native SSH client

This package is an argv/stdin and stdout/stderr/status transport for the running application's
public agent contract. Command parsing, reference content, access, discovery, targeting and
extension policy belong to the application. The client has no daemon, installer, update service
or command registry. A lost exchange is uncertain and is never replayed.

The four bundled targets use pinned Rust 1.99.0 and the checked-in Cargo.lock:

| Client | Rust target | Declared support floor | Linkage |
| --- | --- | --- | --- |
| linux-x64 | x86_64-unknown-linux-musl | Linux 3.2 | static musl 1.2.5, no interpreter or shared libraries |
| linux-arm64 | aarch64-unknown-linux-musl | Linux 4.1 | static musl 1.2.5, no interpreter or shared libraries |
| macos-x64 | x86_64-apple-darwin | macOS 11 | system libraries, deployment target 11.0 |
| macos-arm64 | aarch64-apple-darwin | macOS 11 | system libraries, deployment target 11.0 |

The [Rust platform table](https://doc.rust-lang.org/rustc/platform-support.html) establishes
musl 1.2.5 for both Linux targets. Rust's [Linux baseline announcement](https://blog.rust-lang.org/2022/08/01/Increasing-glibc-kernel-requirements/)
establishes the 3.2 x64 musl baseline and says ARM musl already required a newer kernel. Linux
4.1 is the chosen conservative ARM support floor, matching Rust's documented ARM Linux
platform baseline; the table does not separately promise a musl-specific 4.1 kernel minimum.
The build uses the pinned target's self-contained CRT and rust-lld and rejects ELF interpreter
or dynamic-library dependencies. These build properties establish the declared ABI, not
execution on every historical kernel. [Rust's Apple target documentation](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html)
describes deployment targets and supported Rosetta execution. The producer checks Mach-O
architecture, system-only dependencies and the 11.0 deployment command. Actual execution
reports must state the host OS/kernel and distinguish native from translated execution.

From the repository root, install the official pinned toolchain with rustfmt and clippy, then
run `node scripts/build-agent-client.mts <target>` on an appropriate build host. macOS linking
requires the Apple SDK. Linux builds use Rust's self-contained musl linker; `readelf` must be
available. The producer requires clean maintained inputs and records exact Git HEAD, target,
toolchain, unsigned digest and byte count. `--development` labels dirty local preparation and
is refused by release assembly. Run `node scripts/probe-agent-client.mts out/agent-clients/<target>/hvir-agent`
to execute the actual process relay, stdin, explicit endpoint and interruption checks.

Each artifact includes the project license, resolved crate license/copyright files, the
pinned Rust standard-library copyright document, and musl 1.2.5's upstream COPYRIGHT.
`MUSL-COPYRIGHT` is retained verbatim from
<https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5>.
Release assembly requires all four exact-source artifacts before any desktop packaging.
macOS signing validates unsigned digests first and records final signed client bytes in the
runtime manifest while preserving immutable build metadata. Publication and protected
installed-package acceptance remain with the existing release owners.

For a real SSH probe, provision an individually owned fixture that provides SSH, SFTP, POSIX
sh and stream-local forwarding; create `document.txt` in its workspace. Set
`HVIR_REAL_SSH_HOST`, `HVIR_REAL_SSH_PORT`, `HVIR_REAL_SSH_USER`,
`HVIR_REAL_SSH_HOST_KEY` (the pinned OpenSSH SHA256 fingerprint), `HVIR_REAL_SSH_IDENTITY_FILE`, and
`HVIR_REAL_SSH_ROOT_PARENT`, then run
`npm run probe:agent:ssh -- <target> out/agent-clients/<target>/hvir-agent`.
The probe uses real SshHost, SFTP, native client, cache, framing and command owners with a
headless presentation/action adapter. It verifies discovery, admitted document dispatch,
report stdin/context, authorized action dispatch, live help, private marker mode, cache reuse,
revocation and a fresh forward. It does not establish installed Electron or PTY-session
walkthrough acceptance. Its output contains operation/status categories and artifact identity,
never captured command, request or terminal content. Do not supply secrets in logs or chat.
