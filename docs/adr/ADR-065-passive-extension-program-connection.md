# ADR-065: Passive extension program discovery and trusted connection

> Lifecycle: Active
> Supersedes: [ADR-051](ADR-051-approved-finite-connector-execution.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for application-local first-use connections only.

## Context

A ready-to-run extension can need an already installed local program before showing useful
information. Requiring a host choice, absolute path, raw configuration and separate inspection
turns the native trust decision into setup chores. Discovery must not execute a program or
infer approval from package installation.

## Decision

Application-local connectors may declare a bounded first-use setup hint containing a simple
executable basename. Default configuration is an empty argument prefix and no environment
overrides. Workspace connectors cannot participate. Resolve candidates only through bounded
host-qualified filesystem metadata inspection of absolute search locations and conventional
local program directories. Never execute a shell resolver, version probe, package script or
dependency installer. Deduplicate aliases to the same canonical executable. Missing or distinct
ambiguous candidates have an achievable manual program-selection and advanced configuration
route; discovery is a suggestion, not native authority or proof of domain compatibility.

After explicit Add's existing serialized import and acceptance operation settles, its exact
installed activation receipt can initiate one compact trusted connection decision. Receipt
capture performs no setup or GUI effect inside the writer. Revalidate installation, generation,
declaration, canonical executable and complete configuration through the existing approval
owner. Show the actual local program and host-account access, keeping complete configuration
available without requiring editing. Unchanged current approval needs no repeated decision.
The dialog never holds the activation writer queue. Declining or unavailable connection leaves
the committed isolated installation successful and unconnected.

A negotiated connection request from a current visible, foreground ordinary human guest is
only a proposal for the same trusted decision. Agents, update runtimes, action-origin handlers
and requests carrying action invocation authority cannot prompt for or approve these grants.
No source, file, agent, workspace, SSH or delivery authority is implied.

Reuse the existing bounded prepared approvals and their sixty-second decision lifetime, exact
token consumption, durable installation writer and revocation. End each proposal with its
renderer, view/request, activation and writer authority. Disable, replacement, closure and
cancellation retire only its own pending tokens and reject late decisions. A successful atomic
approval write can already be committed when result delivery or later revalidation fails;
report that uncertainty without claiming rollback. A multi-program decision is not an atomic
grant transaction and retains truthful per-binding outcomes.

Program consent uses the existing workbench confirmation modal. A parented macOS native
sheet can temporarily make its workbench window report unfocused; it must not require a
foreground exemption. The connection owner's existing bounded pending record retains the
prepared tokens and publishes only displayed bindings and a proposal identity to its exact
renderer generation. The renderer can return allow/decline for that proposal, never approval
tokens or replacement bindings. Retirement removes the proposal on every existing lifetime
boundary. Native file selection remains a separate explicit fallback; its exact intent and
fresh foreground are checked before and after selection, with late results inert. While the
passive picker is pending, its own sheet becoming non-key does not retire that exact
selection intent. The existing trusted presentation and guest record distinguish actual
selected, unobscured placement from foreground-qualified visibility only for this finite
connection intent. The parent must remain visible and not minimized; exact caller, request,
view, activation and writer provenance remain current. No prepared approval, consent,
execution or hidden runnable guest is introduced in that phase. Fresh foreground is required immediately on return. If the current ordinary visibility
publication lags that callback, only the existing pending record waits for its current
presentation/revalidation signal within the same sixty-second deadline. Selected, unobscured
placement, physical parent visibility and fresh native foreground remain mandatory throughout
that wait; actual withdrawal or cancellation ends it. No polling, new lifetime owner or
visibility revival is introduced. Canonical preparation, consent and saving start only after
ordinary visibility is confirmed, and retain fresh foreground at every boundary. True deselection,
Settings obscuring, explicit cancellation and lifecycle revocation still retire the intent.
The current package bridge retains only a submitted connection request across context
invisibility; all other ordinary requests retain hide cancellation. No additional decision
registry or generic prompt server is introduced.

Incomplete metadata inspection cannot establish unique executable discovery. Continue bounded
candidate collection while reporting incomplete resolution; automatic installation remains
successful and unconnected without an empty picker. Explicit retry may select a program
manually, then undergo the same canonical preparation and consent. An absent or non-executable
saved program falls through to repair discovery; unknown saved-target metadata preserves
incomplete truth. Never infer authority or silently select a later candidate after an unknown
metadata failure.

All unaffected native execution, canonical binding, output, finite admission, updater demand
and isolation rules in ADR-051 and ADR-054 remain authoritative. ADR-064 continues to own
installation acceptance independently of connection success. No new grant store, writer,
general setup engine or core tool-specific behavior is introduced.

## Consequences

Ordinary installed-tool setup needs one understandable trust decision and no path or JSON
entry. Passive discovery cannot recover executable locations supplied only by shell startup;
manual selection remains available. Domain compatibility and readiness still belong to the
package's approved public program observations. Committed partial grants and lost completion
require honest current-state observation rather than automatic replay.

## Rejected alternatives

- Running a resolver or version probe before approval would execute host-account code.
- Installing dependencies or guessing tool-domain folders would add a second setup authority.
- Treating package installation as native consent would omit the exact program decision.
- A GUI wait inside the installation writer would block Disable and ownership release.
- Provisional activations, a second grant store or automatic rollback would duplicate authority.
