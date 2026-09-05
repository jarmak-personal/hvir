# ADR-038: Trust one coherent CI attempt per candidate

> Lifecycle: Active
> Supersedes: [ADR-037](ADR-037-promote-tested-pull-request-candidates.md) | partial | First-attempt-only and rerun restrictions on otherwise exact candidate CI evidence.

## Context

ADR-037 made workflow attempt one the only merge- and release-authoritative execution for a pull
request candidate. That prevented an automatic or partial rerun from replacing failed evidence,
but GitHub's attempt number does not describe whether any evidence ran. A workflow created by the
repository token first enters an approval-required attempt with no jobs; approval executes the
complete workflow as attempt two. The same blanket rejection prevents recovery from an interrupted
hosted runner, network failure, or explicit cancellation. A no-op commit can obtain a new first
attempt without changing the tested tree, so attempt numbering does not strengthen candidate
identity.

ADR-037's exact repository, workflow, pull request, base, head, tree, merge, and release-source
relations remain the trust boundary. This record supersedes only its first-attempt and rerun
decision.

## Decision

Merge and release trust attach to one exact pull-request candidate and one coherent successful CI
attempt. The attempt may have any positive GitHub attempt number. It is coherent only when the
exact attempt contains exactly one completed instance of every prerequisite job and their results
match one complete ordinary or exact version-only execution. The successful `Merge acceptance`
job belongs to that same attempt.

The aggregate reads only its current run and attempt through GitHub's read-only Actions API. Its
workflow dependencies schedule it after the prerequisites but do not substitute results from an
older attempt. A failed-job or otherwise partial rerun omits successful prerequisites from the new
attempt and therefore fails closed. An approval-required attempt with no jobs contributes no
evidence; the later approved full execution may succeed without being treated as a retry of failed
tests.

Release reads the workflow run's current attempt and the jobs from that exact attempt. It neither
searches earlier attempts for successful jobs nor combines jobs across attempts. Earlier failures
remain in GitHub's workflow history, while the current unsuccessful or incomplete attempt remains
ineligible. A changed head remains a new candidate with independent evidence.

hvir does not add automatic retry behavior. A maintainer may explicitly request GitHub's full
workflow rerun for an unchanged candidate. Release continues to read evidence only and never
dispatches, retries, reruns, or cancels CI.

## Consequences

Bot-created release pull requests can pass their documented approval flow, and maintainers can
recover an exact candidate from transient hosted-execution failures without manufacturing a new
commit. Partial reruns cannot assemble a synthetic green result from different attempts.

The merge aggregate gains one bounded read-only GitHub Jobs API dependency. GitHub-hosted CI is
the real integration boundary; pure policy and adapter tests prove exact-attempt selection,
required-job completeness, version-only skips, and failure behavior without claiming to emulate
GitHub scheduling.

The latest attempt determines the workflow run's current conclusion. Explicitly rerunning an
already successful candidate can therefore replace its accepted evidence with a later failure;
the earlier pass is not silently recovered.

## Rejected alternatives

- Keep attempt one mandatory: approval-only runs and transient infrastructure failures remain
  unrecoverable, while a no-op commit bypasses the restriction without changing code.
- Accept GitHub's aggregate `needs` results without inspecting the attempt: a failed-job-only
  rerun can reuse successful prerequisite results from older attempts.
- Select successful jobs independently across attempt history: that constructs evidence no one
  workflow execution produced.
- Add automatic retries or a retry scheduler: retries remain an explicit maintainer decision, and
  hvir does not become a CI orchestrator.
- Accept an earlier successful attempt after a later failure: the workflow run's current evidence
  remains authoritative and unambiguous.
