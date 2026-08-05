# ADR-029: Bounded project file operations and explicit external-source authority

## Context

hvir's Files rail can browse project entries and save an already-open regular file, but it
cannot create, import, organize, or delete entries. Those actions fit the view-first product
only while they remain explicit operations on one visible registered workspace. They must not
turn the Files rail into a general file manager or create ambient access to the application
host's filesystem.

ADR-010 makes `ProjectHost` the transport seam for every project filesystem operation and makes
the registered root the authority boundary. The seam currently supplies immediate read, atomic
write, single-file removal, listing, stat, and realpath mechanics. Recursive copies, multi-entry
batches, recoverable deletion, and access to sources outside registered roots need additional
policy. Implementing that policy separately in `LocalHost`, `SshHost`, Files views, or IPC would
produce different local and remote behavior and duplicate security-sensitive traversal and
failure rules.

External imports add a second authority boundary. An explicit paste, drop, or picker gesture may
identify a disk-backed application-host source that is not part of any registered project. That
gesture is not durable filesystem authority. An external move is more sensitive still: it may
remove that source only after a complete copy is present and verified.

Transfers and recursive deletion also have unavoidable partial-failure cases. hvir needs one
truthful contract for collisions, symbolic links, metadata, limits, cancellation, staging,
verification, cleanup, and per-item results before adding the individual Files actions.

## Decision

### Ownership and authority

One main-owned **project-file operation coordinator** owns recursive traversal, batches,
transfers, staging, verification, cancellation, concurrency, deadlines, cleanup, and operation
results. It depends on narrow project-host and application-host ports. It is not a generic
filesystem service, and Electron bootstrap only constructs and disposes it.

`ProjectHost` remains the authoritative project filesystem seam. It gains only the immediate,
abort-aware mechanics and truthful capabilities needed by the coordinator: the existing
non-following `stat` seam, exclusive regular-file and directory creation, bounded file streams,
approved mode and modification-time updates, no-replace rename, file and empty-directory removal,
recoverable top-level trash when available, and deletion capability disclosure. Host adapters
implement those primitives with local filesystem or SSH/SFTP mechanics; they do not own
recursion, batches, collision choices, fallback workflows, or user confirmation.

The Files feature owns command and drop targeting, dialogs, progress, cancellation, and result
presentation. Its request is data, not authority. Feature IPC accepts messages only from the
current workbench main frame, rebuilds every typed value, and translates them to the
coordinator. IPC owns no workflow policy. Hostile previews and web panes receive neither the
channels nor preload methods for these operations.

An accepted operation has an immutable identity containing:

- the current renderer owner and generation;
- the exact registered, host-qualified workspace root and its canonical root;
- the selected project host and destination directory;
- the selected sources and requested action; and
- an opaque operation ID and generation.

Focus, selection, project, or workspace changes cannot alter that snapshot. A renderer reload,
workspace closure, project closure, replaced host, revoked operation, or application shutdown
cancels its remaining work. A disconnected project host ends the operation rather than silently
resuming publication after reconnect. Cleanup authority for exact coordinator-created staging
paths survives only long enough to remove them when that host is reachable.

### Targets, names, and collisions

Files actions and drops use one visible target rule:

- a real directory row targets that directory;
- a file or symbolic-link row targets its parent directory; and
- empty tree space targets the exact workspace root.

The renderer snapshots that target when the user invokes the action. Main independently proves
that it is a real directory in the snapshotted workspace before any effect.

A user-supplied entry name is valid only when it is exactly one non-empty segment. `.` and `..`,
NUL, `/`, and `\` are invalid. hvir does not trim, normalize, or split another value into a valid
name. Project-host filename limits may still reject an otherwise valid segment and produce a
failed item.

No operation overwrites, merges, or automatically renames an existing entry. Create uses an
exclusive primitive. Copy, duplicate, and move check each top-level destination before work and
use a no-replace publication primitive to close the race with later filesystem changes. An
existing top-level destination is `conflicted`, remains unchanged, and does not prevent unrelated
batch entries from continuing. A copied directory is always one new top-level tree, never a
merge into an existing directory.

The registered workspace root itself cannot be renamed, moved, duplicated, or deleted. A project
entry may move only between real directories inside the same exact host-qualified workspace. A
directory cannot move into itself or one of its descendants.

### Confinement and symbolic links

The coordinator validates the unnormalized request lexically before constructing host-qualified
paths. It canonicalizes the exact registered workspace root once for the operation, then proves
each source parent and destination parent beneath that root. Below the registered-root alias,
every traversed parent component must be a real directory according to `lstat`; operations never
traverse a symbolic link, even when its target would remain inside the workspace. Missing leaves
are allowed only for exclusive creation or publication after their real canonical parent has
been proved.

Recursive traversal uses `lstat` and never follows symbolic links. An external symbolic link, a
symbolic link encountered anywhere in a copied or duplicated directory tree, or any unsupported
filesystem type makes that selected top-level source `skipped`; the result identifies the
offending relative entry, no partial destination is published, and unrelated selected sources
continue.

A symbolic link that is itself a confined project entry may be renamed, moved, or deleted as the
link entry. Its target is never resolved for those effects. Symbolic links cannot be imported or
duplicated. Source and destination parents must still satisfy the real-directory rule.

### Transfer shape, metadata, and limits

Create produces a zero-byte regular file with mode `0644` or an empty directory with mode `0755`.
For copy and duplicate, regular file bytes are unchanged. A source regular file is executable
when any POSIX execute bit is set; its destination mode is `0755` when executable and `0644`
otherwise. Every copied directory uses mode `0755`. File and directory modification times are
preserved at integral Unix-second resolution, the resolution shared by the local and SFTP paths;
directory timestamps are applied after their children.

hvir does not preserve ownership, group, ACLs, extended attributes, birth time, arbitrary mode
bits, sparse layout, filesystem flags, device nodes, sockets, or FIFOs. Absence of usable regular
file or directory metadata is an unsupported source rather than permission to guess broader
semantics.

One operation is bounded to all of the following:

- at most 256 selected top-level sources;
- at most 4,096 total entries, including selected roots and every visited descendant;
- depth 32, where a selected top-level entry is depth zero;
- at most 256 MiB for one regular file;
- at most 1 GiB of logical source payload across all regular files;
- at most four simultaneously open file stream handles;
- one active operation per host-qualified workspace and two across the application; and
- ten minutes from accepted request through final source disposition, including verification,
  publication, and any source retention, trash, or permanent-removal outcome.

Capacity is not an unbounded queue: a request beyond the workspace or application operation
limit receives a visible busy result and may be retried explicitly. Limits are checked during a
preflight traversal and again while streaming so a changing source cannot bypass them. Reaching
an entry, depth, file, or aggregate bound skips that top-level source without publication. The
1 GiB aggregate counts each logical source file once; source revalidation and destination
verification perform additional I/O without consuming a second logical payload allowance. These
bounds do not promise that admitted work will finish: transfer speed and required multi-pass
verification may still reach the ten-minute deadline.

Files stream with backpressure through the narrow ports. Neither renderer nor main buffers a
complete file or directory tree. Each open read or write handle counts toward the four-stream
limit, buffers remain fixed and bounded, and incremental SHA-256 calculation shares the stream.
All filesystem and hashing work is asynchronous from the renderer.

### Staging, verification, cancellation, and results

Every operation that recursively copies bytes builds one top-level source at a time under a
collision-safe hidden staging name on the destination side. The staging entry is adjacent to the
requested destination so no-replace publication remains on the destination filesystem. hvir
sets approved metadata, verifies the complete staged entry, rechecks authority and destination
absence, and only then publishes it. An incomplete top-level entry is never visible under the
requested name.

A regular file verifies by byte length and SHA-256. A directory verifies through a sorted exact
manifest of every relative entry. Each manifest row contains relative path, regular-file or
directory type, normalized mode, integral modification time, and, for a regular file, byte length
and SHA-256. A missing, extra, type-changed, content-changed, symbolic-link, or unsupported entry
fails verification. Duplicate, cross-device project move, external copy, and external move use
this same verifier.

Cancellation aborts streams and prevents any later staging publication. Completed siblings stay
completed, and published siblings are not rolled back merely because a later item fails or the
batch is cancelled. The ten-minute deadline behaves as cancellation with a deadline reason.
Before an irreversible immediate primitive, the coordinator checks cancellation and current
authority again. Once an exact atomic rename, trash request, or permanent removal primitive has
begun, it runs to its truthful result; the item is no longer reported as cancelled, while
unstarted siblings remain cancellable.

Each requested top-level item receives exactly one terminal status: `completed`, `skipped`,
`conflicted`, `cancelled`, or `failed`. The item also carries a bounded reason, the effect that
actually occurred, and source disposition when relevant. `skipped` identifies an unsupported or
limit-rejected source; `conflicted` means no destination changed; `cancelled` means that item was
not published; and `failed` reports an attempted effect that did not reach its promised outcome.
Permanent recursive deletion may fail after removing descendants, so its failed result includes
a bounded removed/retained summary and never claims complete deletion.

Staging cleanup is idempotent and may address only exact paths minted and retained by the
coordinator. It runs after publication, conflict, skip, failure, accepted cancellation, authority
revocation, and shutdown while the host is reachable. On disconnect the coordinator retains a
bounded in-memory cleanup set and one reconnect observer per host, retries after reconnect, and
then removes the observer. At most 256 staging paths may await cleanup per project host. While one
host's capacity is exhausted, new staging operations targeting that host fail busy; its cleanup
debt consumes no cleanup capacity and blocks no operation on another host. The coordinator does
not scan or delete similarly named unknown project entries. If the application cannot reach the
host again before quitting, a staging entry may remain; a remote daemon or unsafe name-based
scavenger would be required to promise stronger offline cleanup and is not authorized.

### Rename, project move, duplicate, and deletion

Rename and same-filesystem project move use no-replace rename. On a case-insensitive filesystem,
a case-only rename uses a collision-safe hidden sibling as an intermediate name. Failure to
publish the requested casing triggers an immediate restore to the original name. If that restore
also fails, the result is failed and identifies the exact retained intermediate entry rather
than claiming the original still exists.

If a project move reports a cross-device boundary, the coordinator uses the verified copy
pipeline and removes the source only after destination publication and verification. Failure to
remove the source is a completed copy with the exact retained or partially removed source state,
not a completed move. Duplicate uses the same verified copy pipeline and always retains its
source. A symbolic-link entry may move only when no-replace rename succeeds on the same
filesystem. If its rename reports a cross-device boundary, the item is `skipped` and its source
remains unchanged because the verified copy pipeline rejects symbolic links.

Project hosts disclose either recoverable deletion, permanent deletion, or no deletion
capability. A local project advertises recoverable deletion only when its injected
application-host trash port is available. It moves the confirmed top-level entry to operating-
system trash; failure leaves the entry in place and never falls back to permanent removal. An SSH
project advertises permanent deletion and requires a stronger, explicit confirmation naming that
host and irreversibility. After bounded preflight, the coordinator removes a remote tree
bottom-up using immediate `ProjectHost` primitives; no remote service or trash command is
installed. A project host with no truthful capability exposes deletion as unavailable.

Deletion of a confined symbolic-link entry removes or trashes the link itself. Deletion never
follows its target. The destructive commit point begins only after final authority, dirty-view,
and confirmation checks owned by the corresponding feature coordinators.

### Explicit external-source grants

Access outside registered projects comes only from an explicit **Paste Files**, external drop,
or native-picker action. A main-owned application-host adapter turns that gesture into a grant
for exact canonical disk-backed regular files or directories. Every internal source path remains
host-qualified with the application-host identity. Renderer requests use opaque grant and item
IDs; any returned names or paths are inert, bounded display descriptors and cannot authorize a
different source.

The adapter rejects a symbolic link, unsupported type, missing source, and any source that is
equal to, inside, or an ancestor of any canonical registered project root. Descendants of a
selected directory receive no independent ambient grant: they are reachable only through the
bounded traversal of that operation, with the same no-symbolic-link rule.

A grant is bound to one renderer owner/generation and one operation generation. It cannot be
reused for another destination or action and is revoked after use, cancellation, renderer loss,
or application shutdown. Revocation aborts reads and prevents publication or a not-yet-committed
source removal. External-source adapters expose only grant-scoped `lstat`, traversal, bounded
read streams, metadata, revalidation, and recoverable trash; they do not expose arbitrary
application-host filesystem methods.

macOS clipboard import accepts only reviewed `public.file-url` or legacy
`NSFilenamesPboardType` payloads and then only canonical local file URLs or filenames. Linux
accepts only reviewed `text/uri-list` entries whose URI scheme is `file` and whose authority is
empty or local. Comments, line endings, percent encoding, payload count, and payload size are
parsed under the shared 256-top-level-source limit and a 1 MiB raw clipboard-payload limit. Plain
text that merely resembles a path, non-file URLs, remote file authorities, and every other
clipboard format are not interpreted. They produce a truthful unsupported result stating that no
disk-backed file list is available.

An external drop uses Electron's supported explicit dropped-file path bridge through the narrow
preload adapter and the same main-owned grant path. Clipboard access, dropped-file resolution,
and native picker access occur only during their initiating gesture. Background clipboard
monitoring and broad renderer filesystem access are prohibited.

### External move

Ordinary clipboard paste and drag-and-drop always copy and leave every source unchanged.
External move is a separately named native-picker action and is available only when the
application host truthfully provides recoverable trash. It never has a permanent-delete
fallback.

For each selected top-level source, external move:

1. records the source type, exact directory manifest, approved metadata, sizes, and hashes while
   copying through destination staging;
2. publishes and verifies the complete destination under its requested name;
3. rereads the published destination and revalidates the source against that original type,
   manifest, metadata, and every file hash;
4. checks live operation authority and cancellation once more; and
5. asks the application-host adapter to trash that exact revalidated source, then confirms it is
   no longer present at the granted path.

Any destination mismatch, changed source, accepted cancellation, authority revocation, host
loss, or unavailable or failed trash step prevents source removal. The published destination may
remain and is reported as a completed copy with source retained. Only confirmed recoverable
source removal is reported as a completed move. Each top-level source has its own commit point,
so one batch may truthfully contain moved items, copied items whose sources were retained,
conflicts, skips, cancellations, and failures.

This decision extends ADR-010 with bounded immediate file-operation primitives while preserving
host-qualified paths, registered-root confinement, local/SSH parity, and the no-remote-server
rule. It applies ADR-014's coordinator and resource-lifetime ownership, ADR-013's hostile-content
isolation, and ADR-026's explicit application-host acquisition and revocation pattern. It does
not supersede ADR-004's minor-edit boundary or generalize ADR-026's provider-specific image path
contract.

## Consequences

hvir can add small, consistent Files interactions without acquiring general file-manager or
editor authority. Local and SSH projects share policy and results while their adapters disclose
real mechanical differences, especially recoverable versus permanent deletion. One verified
copy path supports imports, duplication, cross-device project moves, and external moves instead
of allowing those workflows to drift.

The contract deliberately rejects symbolic-link copies, directory merges, overwrites, arbitrary
metadata, huge transfers, and offline cleanup guarantees. Some valid operating-system filenames
or filesystem objects therefore remain unsupported. Normalizing modes and modification-time
resolution favors truthful cross-host parity over perfect archival fidelity.

External move cannot be atomic across hosts. A destination can exist while its source remains,
and each top-level source commits independently. The itemized effect and source disposition make
that state explicit. After an irreversible trash or permanent-removal primitive starts, the
operating system may complete it even if renderer ownership changes; immutable targets and final
truthful results prevent retargeting, but no cross-filesystem transaction is implied.

Hidden staging can remain after an application crash or an SSH host that never reconnects. hvir
will not risk user data by deleting unknown prefix-matching entries, and installing a remote
cleanup service remains outside the product boundary.

## Rejected alternatives

- Put recursive copy and deletion in `LocalHost` and `SshHost`. That would make transport
  adapters own product policy and invite local/remote drift.
- Put target, collision, or lifecycle policy in Files views, preload, IPC registration, or the
  Electron composition root. Those layers do not own filesystem workflow authority.
- Grant the renderer arbitrary local paths or a reusable external-filesystem token. A gesture is
  authority for one exact operation, not a durable browsing capability.
- Treat plain clipboard text as paths, monitor the clipboard, or accept every native pasteboard
  format. Those choices create ambiguous and ambient authority.
- Follow or recreate symbolic links. Even confined-looking links can change during traversal and
  make copy, verification, or deletion escape its visible source.
- Overwrite, merge directories, or silently choose numbered names. Hidden conflict policy would
  make destructive outcomes unpredictable.
- Buffer complete files in renderer or main, or run recursive work synchronously. That would
  violate bounded resource use and UI responsiveness.
- Delete external sources after write success alone. A successful write does not prove a
  complete, unchanged destination.
- Fall back from trash to permanent deletion. Failure to provide the promised recovery behavior
  must remain visible.
- Install a remote helper, use a remote trash command, or promise cleanup while a host is
  unreachable. Those choices violate the daemon-free `ProjectHost` boundary.
- Roll back completed batch siblings after a later failure. Cross-host rollback would introduce
  more destructive work without providing transaction semantics.
