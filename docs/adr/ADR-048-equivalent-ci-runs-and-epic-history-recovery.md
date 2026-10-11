# ADR-048: Equivalent CI runs and verified epic history recovery

> Lifecycle: Active
> Supersedes: [ADR-037](ADR-037-promote-tested-pull-request-candidates.md) | partial | Single-run candidate selection and missing redundant run association metadata; recorded release merge acceptance remains required.
> Supersedes: [ADR-038](ADR-038-coherent-ci-attempts.md) | partial | Selection among separately created equivalent workflow runs; current complete-attempt rules remain required.
> Supersedes: [ADR-040](ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Recorded merged-PR requirement for tested non-policy epic history only; policy authorization remains unchanged.

## Context

GitHub can create multiple CI workflow runs for an unchanged pull-request head. A workflow
history interruption can also leave a Closed pull request without a recorded acceptance even
though Git history contains its exact tested integration. Contributor verification needs to
recognize proven code without treating absent metadata as recorded approval.

## Decision

The release evidence owner selects equivalent candidates by canonical repository, CI workflow
name/path, pull-request event, head repository, branch and full SHA. GitHub's workflow-specific
[`run_number`](https://docs.github.com/en/actions/reference/workflows-and-actions/variables), which increases for each new workflow run and stays unchanged on rerun, supplies
creation order. The highest unique positive number wins independently of API response order,
conclusion, attempt number and update time. Missing or contradictory ordering fails closed.
Only that run's current positive attempt supplies jobs. Newer pending, failed or incomplete
execution replaces older successful evidence; jobs are never combined across runs or attempts.
Ordinary required jobs and exact version-only classification remain authoritative.

The canonical PR base and integrated first parent must be ancestors of the tested head, and the
integrated tree must equal the head tree. A run association may name another base only when Git
ancestry proves its default merge-ref checkout has that same head tree. Contradictory PR, head,
repository or target identities fail. Empty redundant PR-association arrays do not invalidate
canonical candidate identities, base ancestry and the trusted CI checkout/verification contract.
An unproven tested tree is never equivalent.

Architecture owns a narrow recovery path for a non-policy two-parent merge already reachable
from its canonical epic. Bounded merge/head PR association reads discover exactly one Closed
canonical PR. Its refreshed head, recorded base and exact epic target must match the merge's
second and first parents. Its completing-child trailer must resolve through the native child
parent to that same open epic. The integrated tree must equal the tested head tree, and shared
candidate evidence must prove complete successful ordinary CI and canonical epic reachability.
Open PRs, ambiguity, contradictory accepted merge metadata and missing or failed CI reject
recovery. An unaccepted PR's synthetic `merge_commit_sha` is discovery metadata, never approval.

Recovery rejects the complete PR diff if it changes architecture policy, enforcing checker code,
verification wiring or accepted decision records. Those integrations continue to require
recorded merged-PR acceptance. Recovery cannot authorize its own checker or this decision.
Policy replay, source coverage, budgets, historical ratchets and dependency rules remain binding.
Final cumulative acceptance still uses the protected PR path.

Architecture may consume narrow candidate/run and attempt facts from the release evidence
owners. Shared evidence cannot depend on architecture admission, including erased imports;
the existing ESLint policy and module graph enforce that direction. All these tooling owners
and their dedicated tests retain the ordinary 1,000-line ceiling. No registry or scheduler is
introduced. Diagnostics identify available PR/base/head/merge/run/attempt facts, the failed
requirement and a supported recovery action, distinguishing unavailable API reads from absent
or contradictory evidence without exposing credentials or response bodies.

Release uses equivalent-run selection but requires a recorded accepted merged PR. Recovered
epic history confers no release authority. Native package certification, signing and immutable
source/artifact identity are unchanged.

## Consequences

Verification follows tested code and explicit policy authority despite recoverable GitHub
workflow history deviations. Reopening unchanged candidates can produce independent equivalent
runs without an ambiguity failure. Explicit reruns can replace a former success with current
failure, and non-policy history recovery proves neither recorded approval nor the cause of
missing metadata. Bounded read-only API availability remains necessary for enforcing checks.

## Rejected alternatives

- Select any successful run or older successful attempt: later failed evidence would disappear.
- Combine jobs across runs or attempts: no complete workflow produced that result.
- Require redundant PR associations: canonical proof can remain complete when that array is empty.
- Fabricate merged fields or accept caller/comment attestations: neither proves recorded approval.
- Recover policy/checker/decision changes: the proposal would authorize its own enforcement.
- Extend recovery to release, automatic merge or CI retries: those retain their existing owners.
