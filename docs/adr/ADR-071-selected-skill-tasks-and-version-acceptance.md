# ADR-071: Selected-skill tasks and version acceptance

> Lifecycle: Active
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Mandatory complete-file presentation and acknowledgment before accepting an exact version, and refusal of acceptance solely because a file format cannot be previewed.

## Context

Reading a skill and adding it to a chosen project are ordinary workbench tasks. Manual
connection, repeated source selection, and per-file acknowledgments turn internal checks
into user work without strengthening the CLI's exact-version decision. Independent
application views also need an explicit destination when a human chooses project work.

## Decision

Keep browsing, selected instructions, and contextual Add, Update and Remove controls in
the installed extension. Resolve public library identity and eligibility within that task;
reuse the existing CLI plans, tokens, action admission and uncertainty owners. Display the
exact host-qualified project/worktree, agent and Full/Stub mode before mutation. Create-only
local Add needs no second confirmation. Update and Remove present their affected files and
one confirmation. SSH Full delivery keeps its existing explicit local export choice, complete
preview, grants and confirmation in the selected task. Recorded remote presence is distinct
from freshly verified presence; inspection, update and removal remain available. Advanced
workflows remain separately reachable.

Present the complete public review manifest with every file's path, size, SHA-256 and
executable state. All supported files can be inspected, without mandatory visits, page
acknowledgments or a preparation action. One explicit Accept version decision compares a
fresh complete manifest/token and submits the existing human-only action. That action
revalidates public identity/version/token before invoking the ordinary CLI acceptance argv.
Reading stays independent of acceptance and retains its existing confined read grants.
Unsupported previews are labeled accurately and do not become a second acceptance policy;
Skillager alone decides eligibility, scanning, overrides, history and mutation locking.
Changed or incomplete manifests still refuse acceptance; nothing silently omits files.

The trusted workbench may let an ordinary human application view choose a registered,
available project/worktree. Its initial context remains independent until that explicit
choice. The existing context owner admits the selected host-qualified workspace; the guest
receives only that chosen context, not the workspace catalog. The same guest retains query,
selection and reading position. Changing a destination revokes old reads and prepared tasks,
and cannot retarget a submitted action. Guest and agent origins acquire no targeting power,
source permission, connector approval or mutation privilege from this control.

The platform continues to own generic context, installation, access and lifetime behavior;
it does not parse Skillager commands or policy. Shared document presentation renders leading
frontmatter as secondary metadata while Source retains every original byte. Parameterized
actions in Settings route to their declared task view instead of submitting missing inputs.

## Consequences

Common tasks require fewer decisions while preserving exact CLI authority. Preview support
and acceptance eligibility are distinct facts. Destination changes require careful request
revocation and submitted-operation isolation. A human may accept without opening every file;
the interface makes all files available but does not claim to measure the human's review.

## Rejected alternatives

- Treating per-file clicks as evidence of comprehension adds ceremony and duplicate policy.
- Automatic acceptance, overwrite or merged read/program grants changes authority.
- Guest workspace enumeration or arbitrary target paths widens the public capability boundary.
- Reopening every selected skill in a management form loses reading and search context.
