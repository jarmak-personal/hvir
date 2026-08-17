# Agent-work measurement contract

This document is the canonical contributor vocabulary for forecasting and measuring work
authorized through hvir's agent lifecycle skills. It defines domain facts shared by lifecycle
skills, harness providers, repository measurement operations, and Project projections. It does
not define a generic telemetry system, model dispatch policy, pricing model, or application
runtime feature.

Measurement is optional evidence. Missing or incomplete evidence never blocks normal issue
planning or delivery, and a collector never guesses a missing value or substitutes zero for it.

## Attributed phases and runs

A **run** is one bounded, authorized execution or resumed execution of one lifecycle skill for one
issue and one phase. A run has one start observation, one finalization observation, and at most one
active measurement record. A later correction, reopened issue, or resumed cleanup is a new run.
Maintainer work and waiting time are not agent work.

Each phase has exactly these observable boundaries:

| Phase | Start observation | Finalization observation |
| --- | --- | --- |
| `issue-planning` | The authorized `hvir-create-issue` execution begins. | After publication approval, the final planning snapshot is taken immediately before the fixed issue-publication operation. The record is appended after the issue exists. Work that never produces an issue has no issue ledger to receive a record. |
| `implementation` | The authorized `hvir-implement-issue` execution begins for the named issue. | The skill returns either a locally verified, pushed candidate handoff or an explicit no-candidate terminal outcome. A review-driven correction or other later in-scope correction starts another implementation run. |
| `implementation-review` | The authorized independent `hvir-review-code` execution begins for an exact candidate. | The reviewer returns its final verdict and findings for that candidate. Fixing a finding is implementation work, not review work. |
| `epic-coordination` | The authorized `hvir-implement-epic` execution or resumed cleanup execution begins for the named epic. | The coordinator returns a cumulative candidate handoff, an explicit terminal blocker, or the result of bounded post-merge cleanup. Child planning, implementation, and review never move to the parent phase. |

A separately delegated `hvir-review-issue` execution is another `issue-planning` run. Its run
starts at that authorized invocation and finalizes when the reviewer returns its verdict, while
the containing phase still uses the publication boundary above. Include its truthful attributable
counters when available; an unavailable reviewer counter never authorizes the drafting agent to
guess it. An independent review of a cumulative epic candidate is an `implementation-review` run
owned by the epic. The coordinator's scheduling and response to that review remain
`epic-coordination` work.

A start and finalization snapshot must refer to the same qualified harness run. If that identity
cannot be proven, the record is `unavailable`; consumers must not combine nearby sessions. A
finalization observation closes the run even when collection is partial or unavailable.

One **phase total** is the aggregation of all active runs for the same issue and phase. It is not a
run total, an issue's Own total, or an epic Rollup.

## Forecast rubric

The forecast describes expected implementation work before substantive implementation begins.
It keeps the four factor scores and a concise rationale alongside the three headline values. File
count, line count, commit count, and test count are not difficulty inputs by themselves.

### Difficulty factors

Score each factor from 0 through 2 using the highest anchor that applies:

| Score | Reasoning novelty | Ownership breadth | Lifecycle / integration | Validation burden |
| --- | --- | --- | --- | --- |
| 0 | The behavior and governing rule already have a direct repository precedent; the work is mechanical or documentary. | One known owner changes behind an existing seam, with no public-contract change. | Pure or documentary work with no resource, async, persistence, or external-system lifecycle. | Static checks or one focused pure-policy test establish the outcome. |
| 1 | Existing policy must be adapted, or one contained interaction requires judgment. | Multiple modules under one owner change, or one existing public seam and its consumers change. | One known effectful lifecycle, persistence path, or external integration changes with established cleanup and failure policy. | Several focused seams or one integration/smoke environment are required. |
| 2 | New policy or algorithmic reasoning is required, or several plausible interactions lack a direct precedent. | Multiple product owners, processes, or public seams must coordinate, or a new authoritative contract/coordinator is required. | Multiple async/resource lifetimes, retries, partial failures, or external systems interact. | Real transport, multiple platforms, packaging/release, capacity evidence, or several integration environments are required. |

Add the four scores and derive **Agent difficulty** without overriding the result:

| Agent difficulty | Factor sum | Concrete interpretation |
| --- | --- | --- |
| 1 | 0–1 | Direct, localized work with almost no novel reasoning or integration. |
| 2 | 2–3 | A contained change requiring limited adaptation across known ownership. |
| 3 | 4–5 | Material reasoning or breadth, but the authoritative seams and validation path remain tractable. |
| 4 | 6–7 | Broad or novel work with substantial lifecycle, integration, or validation coupling. |
| 5 | 8 | Novel cross-owner work at the maximum anchor in every factor; decomposition or prior design alignment is normally expected. |

Difficulty predicts agent work. It is not risk, confidence, elapsed calendar time, or a
retrospective score.

### Risk

**Risk** records the highest credible consequence of an incorrect change, independent of how
hard the implementation appears:

| Risk | Consequence anchor |
| --- | --- |
| Low | Local and readily reversible; ordinary focused checks should detect the failure before it affects a contributor or user. |
| Moderate | Can break a contributor/user workflow or retain incorrect recoverable state, but has a bounded recovery path and does not cross a security or release-integrity boundary. |
| High | Can cause data loss, inaccessible recovery, security/privacy exposure, remote-host harm, or a broadly shipped regression requiring coordinated recovery. |
| Critical | Can plausibly cause irreversible or widespread loss, credential or supply-chain compromise, or violation of a foundational authority boundary across installations. |

### Estimate confidence

**Estimate confidence** records uncertainty in the forecast, not optimism about success:

| Confidence | Uncertainty anchor |
| --- | --- |
| High | Scope and acceptance are settled, the owner and seam are known, and the validation path has a direct precedent. |
| Medium | One material unknown remains, but it is bounded and is unlikely to change the desired outcome or primary owner. |
| Low | Multiple material unknowns remain, or provider/external proof, product alignment, or architectural authority may change the scope or outcome. |

The **initial forecast** is the first forecast preserved on the aligned issue. If discussion
materially changes scope after that record but before implementation, append one explicit
**pre-implementation revision** with its own factors, headlines, rationale, and reference to the
initial forecast. Never edit or replace the initial forecast. Once implementation starts, do not
record another forecast and do not create a subjective actual-difficulty score.

## Usage vocabulary

The bounded provider procedure and observed supported-provider result are documented in
[`agent-work-usage-proof.md`](agent-work-usage-proof.md).

### Token categories

Token counters are non-negative integers. Omission means unknown or unsupported; an explicit zero
means the provider truthfully reported no tokens in that category.

The four additive categories are disjoint after provider normalization. If native counters
overlap, the provider adapter must separate them truthfully or mark the normalized total partial
or unavailable.

- **Fresh input tokens** are input processed without a cache-read or cache-write attribution.
- **Cache-read tokens** are input supplied from a provider cache.
- **Cache-write tokens** are input attributed to creating or refreshing a provider cache entry.
- **Output tokens** are all generated output tokens reported by the provider.
- **Reasoning tokens** are the provider-reported reasoning detail within output tokens. They are
  retained separately for analysis but are non-additive: they are never added to output again.

The provider-neutral **normalized token total** is:

```text
fresh input + cache read + cache write + output
```

A provider may emit this total only when its adapter can account truthfully for every additive
category that the provider can produce for the run. Provider-native totals may be used when the
adapter proves they have exactly the same semantics. Missing reasoning detail does not by itself
make the normalized total incomplete because reasoning is already contained in output. Missing
additive counters make the total partial or unavailable; they are never treated as zero. Keep the
individual counters even when a normalized total is available so cache use and fresh input are
not treated as interchangeable.

### Timing values

- **Active wall time** is monotonic elapsed time while the agent run is active, including tool,
  local check, and external API execution. Explicit suspension while awaiting maintainer input or
  acceptance is excluded. It is a duration, not the difference between GitHub timestamps.
- **Model or API time** is only a duration reported by the harness/provider for model or API
  execution. It is not inferred from active wall time or terminal output.
- **Time to first candidate** is the accumulated active wall time from the start of the first
  implementation run through the finalization observation of the earliest locally verified,
  pushed candidate. It excludes maintainer wait, review after that handoff, and all later
  corrections. It remains absent while no candidate exists and never changes after the first
  candidate is established.

Timing values are non-negative durations with an explicit unit. Provider snapshots retain their
available timing facts independently; a missing model/API duration does not erase an available
active-wall duration.

### Route and first-pass outcome

The **initial route** is the exact harness, model identifier, and requested or effective reasoning
effort observed at the start of a phase. A **route change** records a later observed model or
reasoning-effort tuple and its order within the run. An **escalation** is an explicitly declared
route change made to obtain greater capability or reasoning effort; consumers do not infer it
from model names, prices, or a hard-coded ranking. If requested and effective effort differ, keep
both when the harness exposes both.

**First-pass outcome** is derived only from candidate and rework facts:

- `pending`: the first candidate exists and has not yet been accepted or sent back for rework;
- `accepted`: that exact first candidate is accepted without a later corrective implementation
  run;
- `rework-required`: a later implementation run begins to correct the first candidate before
  acceptance; or
- `no-candidate`: an implementation run finalized without producing any candidate and no later
  candidate fact is yet available.

`rework-required` is sticky even if a later candidate succeeds. Review findings that require no
candidate change do not count as rework. A changed candidate produced for an in-scope correction
does. Consumers do not infer first-pass outcome from sentiment, review prose, or elapsed time.

## Availability, append-only history, and corrections

Every finalized run has one availability state:

- **Complete**: both qualified snapshots exist and every counter required for that provider's
  normalized total is present; all other claimed fields are supported observations.
- **Partial**: the run identity is proven and at least one supported usage or timing fact is
  present, but a required snapshot or additive counter is missing. The record identifies the
  missing facts and may expose a labeled known subtotal, never an exact total.
- **Unavailable**: no truthful attributable usage delta can be produced. The record contains a
  fixed reason code and no guessed counters.

Availability and ledger activity are different. A valid record is **active** until a later valid
record explicitly supersedes it. A **superseded** record remains immutable history but contributes
nothing to projections or totals. Supersession names exactly one earlier record for the same
issue, phase, and run; it cannot cross issues or silently replace unrelated evidence.

The issue ledger is append-only:

1. Finalizing a run appends one recognized fixed-schema measurement record.
2. Each intended record has a content-free idempotency key derived from bounded operation
   identity, never from prompt, response, issue, or code text.
3. Retrying the same operation with the same key is a **duplicate** and returns the existing
   record without appending or counting usage again.
4. Correcting a valid record appends a new record with a new key and an explicit supersession
   reference. Existing comments are never edited or deleted.
5. Ledger-derived Project values are updated only after the ledger append succeeds. A projection
   retry reads the active ledger and does not append another measurement.

The exact versioned comment marker, record schema, named dry-run/apply command, and normalized
report are documented under [Agent-work measurement ledger](project-management.md#agent-work-measurement-ledger).

Only unedited records emitted by the named repository measurement operation, authored by the
configured repository owner, and carrying the exact recognized schema marker participate. The
repository token used for appends authenticates as that same narrow trusted actor. Marker-shaped
comments from other authors are unrelated and never parsed; malformed or edited trusted records
produce fixed, content-free diagnostics. Reading paginates the complete comment history and
exposes normalized records, not raw comment bodies, provenance, timestamps, or GitHub internal
identifiers.

## Own totals and epic Rollups

An issue's **Own phase total** combines active runs for one phase. Its **Own lifecycle total**
combines that issue's Own totals for `issue-planning`, `implementation`,
`implementation-review`, and, for an epic, `epic-coordination`. It never includes work attributed
to a child. An ordinary issue and an epic child have no Rollup.

An epic's **Rollup** combines its Own per-phase and lifecycle totals with the current Own totals of
each native direct child exactly once. Planning, implementation, and review remain distinct phase
subtotals; the lifecycle subtotal additionally includes the root epic's coordination work.
Rollups are not recursive: nested epics are unsupported, and a grandchild is never traversed.
Reopened or additional work updates the owning issue first, then a later reconciliation updates
its direct parent. Superseded and duplicate records contribute nothing.

If every contributing run has an exact normalized total, the aggregate is complete. Otherwise,
the aggregate remains partial or unavailable, reports coverage and any known subtotal, and is not
presented as an exact token total.

Example with complete values:

```text
Epic #700 Own lifecycle total:        1,000
Child #701 Own lifecycle total:       2,000
Child #702 Own lifecycle total:       3,000
Epic #700 Rollup:                     6,000

Project-wide sum of Own values:       6,000
Project-wide sum of Own + Rollup:    12,000  (invalid: child work counted twice)
```

If child `#702` instead has a known subtotal of 2,500 and one unavailable run, the epic Rollup is
partial with a known subtotal of 5,500; it is not an exact 5,500-token Rollup.

The repository's separate Rollup reconciliation reads native relationships and active ledgers,
then owns the root epic's standard phase, lifecycle, and coverage Project fields. One-issue
projection owns those fields for ordinary issues and epic children and preserves them for root
epics. A lifecycle ledger change reconciles Rollup only when the changed issue is a root epic or
has one exact native parent; ordinary issues and epic children never run a self Rollup.
Reconciliation never edits child history or child Project values. Nested epics, nested
descendants, and relationship ambiguity never trigger recursive aggregation. Project-wide
analysis excludes root-epic aggregate rows when summing issue-owned work, preventing child work
from being counted twice.

## Record examples

These examples describe semantics, not the eventual wire format or schema marker:

- **Complete:** qualified start and end snapshots yield fresh input 100, cache read 50, cache
  write 10, output 20, and reasoning 5. The normalized total is 180, not 185, because reasoning is
  already part of output.
- **Partial:** the start snapshot and run identity are proven, but the end snapshot lacks a
  cache-write counter. Known counters may be retained; no normalized total is emitted.
- **Unavailable:** the harness exposes no qualified usage artifact. The record contains the fixed
  reason `unsupported-telemetry` and no token values.
- **Duplicate:** a retry presents the same idempotency key after an append succeeded but before
  Project projection completed. The existing record is reused and the projection resumes.
- **Superseded:** a complete record attributed output to the wrong run. A correction appends an
  unavailable or corrected record that explicitly supersedes the old one; only the correction is
  active.

## Content and identity exclusions

Measurement records, normalized reports, diagnostics, logs, and Project projections must never
retain, copy, derive excerpts from, transmit, or expose:

- prompts, responses, reasoning text, transcripts, terminal input/output, code, diffs, file
  contents, filenames or paths, commit messages, issue/PR titles, bodies, comments, or other
  public-content text;
- environment values, credentials, authentication material, rate-limit details, account or plan
  details, pricing, or monetary cost; or
- provider session/conversation/account/user identifiers, artifact names or paths, raw provider
  records, GitHub internal IDs, or other values that can locate or correlate a private provider
  artifact.

Allowed identity is limited to the repository issue/phase/run relationship needed for bounded
idempotency and attribution, the exact harness and model identifiers, reasoning-effort facts, and
content-free candidate/outcome references required by the repository operation. Harness-specific
artifact discovery, qualification, and parsing remain inside the bundled provider boundary; its
consumer receives only the whitelisted numeric and model metadata defined here.

The contract requires neither model pricing nor monetary cost, and it never assigns monetary
value to maintainer time.
