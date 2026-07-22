# ADR-017: Defer direct diagnostic report delivery to harnesses

## Context

ADR-016 authorizes a bounded local diagnostic report that the user can preview, copy, save,
and delete. Delivering that report to a harness would be a different authority boundary. It
would mutate a provider conversation, could cross from the local application host to an SSH
host, and would need truthful text and attachment semantics for the exact provider version and
session.

The provider registry in ADR-012 owns launch, exact recovery, identity, probes, and observation,
but no bundled provider currently exposes a reviewed semantic operation for adding text or an
attachment to an exact existing conversation. A provider/session identity does not prove that a
terminal TUI is currently accepting prompt input. Writing bytes to its PTY could interleave with
user input, target another TUI state, or be interpreted as terminal control rather than one
atomic message. Starting a fresh triage conversation would instead make hvir own new session and
conversation orchestration.

ADR-013 therefore reserves any future direct delivery for an explicit provider capability under
exact PTY ownership and rejects a generic PTY write. Optional images make the boundary stricter:
many CLIs have no attachment contract, and staging a local image in a project or SSH host would
create persistence and transfer authority solely for delivery convenience.

## Decision

Defer direct diagnostic report delivery. The v1 product boundary is ADR-016's exact Preview plus
explicit Copy or Save. hvir does not target an existing conversation and does not start a new
triage conversation.

This decision extends ADR-012 by declining to add a speculative report-delivery capability to
the provider vocabulary. It extends ADR-013's future-delivery clause by retaining the
prohibition on generic PTY writes and ambient “active harness” inference. It does not supersede
either record. ADR-016 remains unchanged: report preparation produces a neutral, clearly
delimited untrusted artifact and authorizes no provider delivery.

No delivery coordinator, target-selection IPC, attachment-transfer path, or placeholder provider
API is added. Bare Shell and custom-command profiles remain unsupported because they have no
conversation semantics. Core report behavior does not name `hvir-create-issue`, create an issue,
or imply that review grants prompt or publication authority.

Revisit direct delivery only through a new decision when all of these conditions have concrete
evidence:

- At least one trusted bundled provider has a documented, version-probed semantic operation for
  submitting text to an exact existing session without terminal byte injection. Provider,
  profile, session, terminal owner/generation, destination host, and capability revision can all
  be proven at authorization time.
- Text and attachment support are independent truthful capabilities. An attachment path does not
  require ambient upload infrastructure or temporary material in a repository, project, or SSH
  host.
- The confirmation surface can show the exact reviewed payload, target conversation, destination
  host, local-to-remote crossing, and attachment behavior immediately before authorization.
- The provider contract defines generation revocation, cancellation, acknowledgement,
  idempotency, disconnect and capability-drift behavior, partial transfer, late completion, and
  cleanup without altering unrelated terminal input, output, or recovery state.
- A demonstrated product need justifies mutating an existing conversation. Starting a new triage
  conversation remains outside this revisit and requires its own orchestration decision.

## Consequences

Users retain one manual step after review, but they choose the destination conversation and use
the harness's own input or attachment affordance. hvir neither overstates target identity nor
silently crosses a host boundary. Preview, Copy, and Save continue to work for every provider,
Bare Shell, custom commands, and local or SSH projects without inventing lowest-common-denominator
delivery semantics.

There is no in-product promise of exact harness delivery or attachment support. The downstream
implementation proposal is closed as not planned. A future proposal must supply the provider and
host evidence above rather than treating this deferral as an implementation backlog item.

## Rejected alternatives

- Write the reviewed text through the PTY supervisor. Exact PTY ownership does not make terminal
  bytes an atomic provider message or prove the TUI's current input state.
- Infer the destination from the active terminal, title, cwd, latest provider session, or visible
  pane. Visibility and ambient identity are not conversation authority.
- Start a dedicated triage harness session. That would make hvir orchestrate conversation purpose,
  launch, recovery, and cleanup beyond its view-first role.
- Stage images in the project, on the SSH host, or in an ambient upload service. Delivery
  convenience does not authorize new persistence or transfer infrastructure.
- Add optional provider interfaces before one provider has exact semantics. A speculative API
  would freeze unverified vocabulary and push provider quirks into callers.
- Special-case the repository's issue-creation skill. Diagnostic reports remain neutral data, and
  issue drafting and publication keep their separate user approvals.
