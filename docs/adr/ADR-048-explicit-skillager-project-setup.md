# ADR-048: Explicit Skillager project setup and existing skills

> Lifecycle: Active
> Supersedes: [ADR-046](ADR-046-explicit-skillager-library-and-exposure-authority.md) | partial | Local project setup terminal handoff and Working installation, existing-project metadata presentation, and post-handoff terminal lifetime only.
> Supersedes: [ADR-047](ADR-047-explicit-skillager-library-initialization.md) | partial | Interactive setup and shell-launch exclusion only for the separately requested project setup handoff; personal-library initialization and first-skill guidance remain unchanged.

## Context

A project's native skill folders can exist without managed exposures or completed Skillager
setup. Showing only exposure records makes those projects appear empty and hides pending work.
Interactive Skillager setup also owns decisions and Working installation that should remain in
the CLI rather than becoming a second hvir setup/review form.

A fresh terminal handoff requires explicit execution authority and a clear lifetime transition:
requests belong to the enabled feature until launch, while a successfully handed-off terminal
belongs to the user's ordinary session lifecycle. Library initialization and project setup have
different effects and must not be conflated.

## Decision

### Existing project skills through public metadata

For a connected local workspace, **This workspace** includes discovered existing project skills
as well as managed copies. Use supported public Skillager discovery/review metadata, retaining
pending and lint-blocked rows even when an approved-only listing omits them. Show the actual
review state and distinguish project-native/unmanaged presence from a verified managed exposure.
An existing file is not a managed copy, library import, content approval, or proof of readiness.
Retain public native-agent labels: project discovery may report both Codex and Claude skills,
independently of the agent chosen for setup.

Skillager remains authoritative for discovery, indexing, identity, hashes, trust, scanner/linter
policy, and readiness. Hvir allowlists renderer metadata and publishes neither instruction bodies
nor scanner excerpts through this read path. No private database/state-file access, hvir skill
scanner, body index, or inferred approval is introduced. A bounded public refresh may maintain
Skillager-owned cache/index state but never approves content, installs Working, or changes an
exposure. Public project-source filtering happens after Skillager's normal project/environment,
global-native and package discovery; it is not a promise of project-only filesystem scanning.
This observes the same effective local CLI scope as workspace search/readiness. Use the explicit
selected personal catalog and the real CLI-owned project state shared with interactive setup,
not a discarded isolated read-state directory that would hide setup decisions. Heavy execution
and parsing remain off paint under explicit response, deadline and concurrency bounds.

Managed Add, Update, Remove and canonical-library review/acceptance keep their existing grants
and exact source/target protections. Project-native or unmanaged rows cannot acquire these
management actions merely by appearing in the list. Read-only metadata details may identify their
location and review state; interactive project decisions stay in Skillager. A zero-row public
result says **No project skills reported by Skillager**; it does not prove a
complete or readable scan, because the supported metadata contract can omit discovery errors.
A submitted search with no matches and a failed command or unsupported schema retain their own
no-match or unavailable state.

### Explicit setup in a new terminal

Keep the sidebar compact. Reuse the existing Codex / Claude agent selector and show **Set up in
terminal** when the selected local project needs setup or further setup/review work. Before
launch, display the exact local project/worktree and agent, and identify that the action opens a
new terminal running the selected installed Skillager's interactive `setup --agent <agent>`.
Skillager owns its discovery, review questions and Working installation for that selected agent.
Hvir supplies no approval, reset or force flags and no parallel setup wizard.

The click authorizes that one command, workspace and agent. The main-owned Skillager capability
prepares a one-use launch identity bound to the current renderer, enabled connection/executable
selection, exact registered host-qualified workspace and selected agent. Submission consumes
that identity and revalidates current authority; arbitrary renderer executable, argv, environment
or destination values cannot replace it. Duplicate, changed, stale or revoked requests cannot
spawn another terminal. Enabling, browsing, refresh, selection changes and restart never launch
setup, and existing terminals never receive the command.

A narrow handoff uses the existing terminal session owner, PTY supervisor, host-qualified
ProjectHost launch, stream attachment and cleanup. Keep Skillager command/readiness policy in
the feature owner rather than harness providers, terminal transport, IPC or composition roots.
This is a named project setup capability, not a general task runner, persistent command profile,
or automatic recovery task. Installation and updates remain user-managed. Hvir does not initialize
project Git, edit ignore files, automatically approve skills, or force replacement through this
handoff; the user answers Skillager's interactive choices in the terminal.

### Terminal ownership and observed completion

Before successful handoff, disable and ordinary renderer/connection/selection revocation cancel
pending admission and reject late publication. Partial launch uses the terminal owner's existing
cleanup; it does not create a second feature-owned PTY lifetime. Once handed off, the terminal is
an ordinary user-controlled session. Its owner handles input, exit and closure. Disabling Skillager
removes feature-owned surfaces and observation but does not inject input, erase terminal output,
or kill a handed-off or unrelated terminal. The disabled Settings toggle remains the only
feature control; ordinary terminal content is preserved. Recovery never replays the setup command.

On completion or the next visible refresh, observe supported public metadata/readiness for the
same still-current workspace, agent and connection. Never interpret terminal text, infer readiness
from exit zero, publish a stale success, or switch the user's workspace. Keep actual pending,
blocked, paused, incomplete, unavailable and ready outcomes, including observed Working state.
A saved setup-complete flag alone does not prove Working is installed. Read selected-agent
Working readiness and concrete selected-agent artifact evidence independently; readiness booleans
or absent artifact data alone do not establish an installed Working skill. Report only distinctions
supported by the public response. If paused versus incomplete cannot be observed, retain the
truthful review-needed or unknown state rather than inferring a pause from output or exit.
Do not show Ready beside unresolved native discovered or lint-blocked rows when the public
readiness reports review needed. Explicitly
blocked rows may remain visible even when public Working readiness permits proceeding.
Further work offers another explicit setup handoff; it never restarts automatically. Selection
changes and disable revoke observation and any stale result while retaining ordinary terminals.

### Local project boundary and unaffected library setup

Project discovery and interactive Working setup use the installed local CLI for local projects
only. SSH project catalog/setup remains explicitly unavailable; never execute a remote path as a
local cwd or install/run Skillager or Working remotely as a fallback. Existing verified SSH Full
skill delivery and protected remote exposure status remain governed by ADR-046.

ADR-047's personal-library initialization, Git choice, status reconciliation and first-skill
guidance remain unchanged. A new local personal library still uses the noninteractive Create and
connect flow. Its grant does not run interactive project setup, and the separate project terminal
handoff does not implicitly initialize/register a different personal library.

## Consequences

Users can see existing project skills before completing setup and can finish CLI-owned review
and Working setup in a dedicated terminal. This adds one bounded handoff and public observation
path without extending hvir into an authoring or setup IDE. Ownership labels and unavailable
states remain necessary because discovery, approval, exposure and Working readiness are different
facts. A handed-off terminal may outlive the feature's visibility or enablement, and its setup
command is deliberately not recoverable through automatic replay.

## Rejected alternatives

- A full-viewer setup form duplicates Skillager's interactive decisions and creates a second
  readiness/approval policy in hvir.
- Showing only managed exposures or approved-only lists hides native pending and blocked skills.
- Treating every native folder as managed would authorize replacement or removal without proof.
- Injecting setup into an existing terminal risks user input and unrelated session state.
- Automatic setup, approval flags, persisted command profiles or replay after recovery expand one
  deliberate handoff into an unattended workflow.
- Reading terminal output or exit status as readiness duplicates public metadata and hides paused
  or incomplete outcomes. Remote installation as a fallback violates the existing host boundary.
