# ADR-059: Public local Skillager management

> Lifecycle: Partially superseded
> Superseded by: [ADR-060](ADR-060-public-skillager-advanced-exposure.md) | partial | Exclusion of native adoption from local management; complete public preservation-backed adoption is permitted by this decision.
> Superseded by: [ADR-067](ADR-067-cli-owned-personal-library-creation-defaults.md) | partial | Mandatory explicit initialization path and separate Git choice only.

## Context

The installed Skillager extension can observe personal and project inventories and open
selected current instructions. Local initialization, approved-source synchronization and
managed Full/Stub copies require explicit intent and truthful native outcomes. Reproducing
Skillager's catalog, scanner or content-hash implementation would create competing authority.
Native connector approval and instruction reading establish different facts from content
acceptance or permission to replace a project copy.

## Decision

Keep these workflows in narrow extension-local operation, public-contract and presentation
owners. Consume the installed CLI through the existing approved D5 connector and admitted D4
action lifetime. Agent calls consume existing D6 authorization for the declared action,
effects, host and workspace. D7 selected-current reading remains independent: pending and
blocked entrypoints can be human-read without accepting them, and ordinary agent calls never
gain instruction bodies. Core does not acquire Skillager-specific commands, parsers, hashes,
scanners, workflows or trust records.

An action invoked from an ordinary human guest opens its separate action-origin handler
without changing the caller's selected view. Existing D4 runnable admission lets that handler
finish while hidden, and main still owns its finite result and cancellation lifetime. Agent
and trusted Settings invocation retain their ordinary viewer selection. A submitted human
invocation can finish through later hiding; new requests and body reads remain visibility
gated, and destruction or revocation cancels pending work.

The package's guest transport accounts for every outbound request and control message in
a conservative monotonic rolling window below the public message ceiling. Short bounded
sequences may burst; saturation waits remain admission-bound and teardown clears them.
This avoids accumulating Chromium's background timer clamping between individual output
pages without changing native throttling, hidden-view suspension or any main-owned limit.
Main-issued action end and revocation need no redundant cancellation messages; local hiding
rejects pending reads immediately, with only already-submitted requests eligible for native
cancellation. Neither local rejection nor cancellation delivery proves physical rollback.

Initialization requires an explicitly displayed absolute local library location and an
independent Git-history choice for a new library. The public CLI does not report its default HOME-based target
before initialization; do not fabricate that path or read private CLI environment/state to
recover it. Invoke exact public `library init --path ... --json`, adding `--no-git` only for
the explicit choice. Verify its supported result and subsequent public status, canonical
registered root, library UUID and actual Git mode before connecting. A different observed
location or history mode requires an explicit connection choice. Registering an existing valid
library preserves its actual history mode; the choice does not convert or reinitialize it.
Registration may already have occurred when verification disagrees, so report the observed
state rather than claiming no effect. An existing different registration is not implicitly
relocated. Enable, observation, a
folder choice and failed Git initialization never cause implicit initialization or fallback.

Approved-source synchronization uses public status and `library sync --approved` bound to the
observed registered UUID and root. Skillager owns discovery, approval witnesses, lineage,
preservation and copying. Expose actual per-item outcomes and incomplete coverage; process
exit zero alone is insufficient. Complete known conflicts and failures use the public partial
report and exit two, without claiming overall success. Unknown outcomes or incomplete coverage
retain the exact operation for reconciliation. Synchronization does not accept a changed
canonical source. Human confirmation binds a generic metadata digest of the complete validated
public status shown, including all supplied selection and lineage facts; a fresh changed status
refuses before dispatch and requires a new review. Agent calls retain their current D6
authorization and preflight without inventing a human decision. This detects disclosed-plan
drift before dispatch; the public CLI supplies neither an atomic sync token nor every new
source version fact, so this binding does not claim those guarantees.

Exact acceptance consumes the public `skillager.library-review-manifest.v1` opt-in preview,
bound to registered library UUID/root, skill identity/root, existing working hash and opaque
confirmation token. In an ordinary human D7 view, present every eligible file and its byte
size, SHA-256 and executable state. Verify each complete confined UTF-8 read or recognized
image against that file identity, then compare a fresh complete manifest/token after all
reads before the human confirms. The action is unavailable to agents and obtains no bodies;
it revalidates the exact public token/version and constructs the corresponding ordinary
acceptance argv. Skillager retains scanner/lint, overrides, Git and mutation-lock authority.
No-Git and first Git versions use the same manifest contract; history is not review evidence.

Eligible nonimage binary, oversized, unreadable or mismatched files refuse acceptance with
their exact paths. They are never omitted or called ready. Route the user to suitable
ordinary file tools and public Skillager CLI review/accept, then Refresh observes current
availability. Complete upstream manifests remain authoritative even when the viewer cannot
fully present a format. Generic per-file verification does not recreate Skillager's tree
hash, eligibility or scanner. Installed source/schema support is required; a package version
alone does not establish that contract.

For local Codex and Claude managed copies, consume complete public exposure/removal previews
and opaque confirmation tokens. Bind the selected accepted source hash, registered library,
host-qualified destination, concrete agent and Full/Stub mode. A deliberate Add may prepare
and apply internally only when every disclosed effect creates the exact absent target for
that selected accepted version. Existing pinned-source eligibility remains Skillager-owned.
An occupied, changed, unmanaged or otherwise protected target cannot turn Add into replacement.

Updates and mode changes bind the selected managed exposure identity; human review exposes
the complete affected-file plan before confirmation. Remove reviews and binds the current
managed target and its removal effects independently of current canonical-source acceptance.
A pending canonical source is not a reason to require reacceptance before Remove. Modified
copies remain preserved when the CLI requires force. No operation supplies force, resets
trust, broadens selection, adopts native content or edits private metadata.

An explicit human-selected project original can reveal its folder in Files for the Files
owner's separate deletion action. The declared read-only `source.reveal` capability requires
the existing exact workspace source grant and current visible human origin. Main revalidates
the admitted workspace and canonical ordinary directory through ProjectHost, refusing lexical
or symlink escape. Its one-shot host-qualified event reaches only the owning renderer and is
rejected after workspace retarget. Files reuses its directory expansion, selection and scroll
lifetime; the extension obtains neither deletion authority nor outside-root access.

Use bounded structured argv and the existing finite output/receipt envelope. Refuse an
oversized or incomplete review before apply rather than omitting effects, paging a partial
plan into authority or relaxing D5 limits. A submitted operation without a verified result
has an operation-specific uncertain outcome and requires explicit public reconciliation.
Only a complete exact copy result with a public reason proven to precede target installation
can report definite preservation and release its operation record. Generic skipped errors may
follow partial installation, and acceptance review refusals may follow Git commits; neither
status nor a nonzero exit alone proves no effects.
Observation, dismissal, reconnect and success for a different operation cannot silently clear
that uncertainty. Mutations never borrow the observation helper's automatic frequency retry.
Revocation rejects late results and connection restoration; it does not claim native rollback.
Live guest records survive hide, dismiss, Refresh and reconnect. Metadata-only report and
reconciliation actions remain scoped to the original caller class and admitted host-qualified
workspace/library, with new D4/D6 admission each time. Reconciliation first observes supported
safe-repeat facts, then acknowledges those exact current facts while original completion
remains unknown. Reload, Disable or guest destruction loses ephemeral records; it does not
replay work or turn unknown completion into success. Every new explicit operation still
requires fresh authoritative preflight and preservation checks. Durable remote records belong
to the SSH delivery decision, rather than a second local journal.

The donor's [initialization decision](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-047-explicit-skillager-library-initialization.md)
retains explicit location/Git intent, independently verified connection, no default fallback,
first-skill guidance and honest reconciliation. Reject its obsolete built-in Skillager
capability, private captured-HOME/default selection and dedicated picker mechanics. The
donor's [bounded direct-Add decision](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-051-quiet-skills-and-bounded-direct-add.md)
retains quiet observations, visible concrete destination/agent/mode, exact create-only Add,
complete task-specific review and preservation. Reject its former built-in mutation owner;
the installed extension and public CLI own those workflows. ADR-058 supplies fresh-terminal
setup independently of domain readiness and ordinary no-replay recovery.

## Consequences

Local management becomes available without a second Skillager implementation. Explicit
locations and bounded previews can require a more deliberate choice or report an unsupported
operation. Native cancellation can leave uncertain effects, so precise public reconciliation
and per-item outcomes remain necessary. Complete exact-tree acceptance requires its own public
manifest/token contract and cannot be inferred from metadata, ordinary reading or Git history.

## Rejected alternatives

- Initializing on enable or retrying without Git would replace the user's intent with hidden
  side effects.
- Reading private catalog files or reconstructing hashes/scanner policy would split authority.
- Treating connector approval or an opened instruction body as acceptance conflates distinct
  grants and facts.
- Applying whatever an Add preview returns would permit silent replacement or source advance.
- Requiring canonical reacceptance for managed Remove would entangle target cleanup with new
  instruction trust.
- A session-wide mutation latch or automatic retry after uncertain dispatch hides which exact
  operation may already have happened.
