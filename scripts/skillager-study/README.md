# Skills interaction study

This maintained offline study illustrates ADR-046 through ADR-051. Its original reference was the
user-owned `skillager-integration.local/` study, whose originals remain untouched. The dark palette,
normal viewer/terminal split and representative skills are retained.

Skills is a left-sidebar peer of Files/Git. Its compact explorer shows In this project and Your
library together, with independent collapsible sections and bounded scrolling. Rows use the Files
visual language. Explicit row/tab activation opens the selected current file in the normal main
viewer; applicable actions sit beneath the title, while source and provenance stay secondary. Exact acceptance review remains separate. The scenario harness stays outside the illustrated app shell.

Generate a standalone HTML file from the maintained sources:

```sh
node scripts/skillager-study/build.mjs /tmp/hvir-skillager-study
```

Open the printed `index.html` in a browser or hvir's HTML viewer. It needs no server, CLI,
network, real library, or file-write permission. Every displayed path, hash, instruction, and
terminal is sample data. All management actions mutate page memory only. Reset restores the
initial disabled state. The scenario selector loads independent examples, including connected,
missing CLI, empty, stale preview, protected targets, remote delivery, and unavailable freshness.

The curation model and view own the new sample source/sync/router interactions; the existing
model and view retain connection, lifecycle, setup and direct-exposure examples. `reading.mjs`
owns the revocable explicit sample read and its current-file presentation. `search-sample.mjs`
illustrates public pre-limit grouped/occurrence responses; `search-views.mjs` owns submitted
controls and matched-source disclosure. None of these modules implements production search or
filesystem access. `reading-check.mjs` reuses the existing headless browser lifecycle.
`curation-actions.mjs` composes the existing curation model/views through page ports, and
`direct-add.mjs` illustrates only exact accepted-version create-only intent through the existing
preview/apply model. `skill-icons.mjs` owns the small accessible glyph markup. Reader and explorer
styles have their own leaves; no application or controller budget exception is introduced.
The source model owns only illustrative state; views produce markup; the browser entry owns
DOM events and page timers. The builder uses the declared Vite dependency to bundle these modules
and stylesheet into a single self-contained artifact outside the maintained tree. Generated HTML,
screenshots, and run evidence are not committed. Ordinary source and dependency checks cover the maintained JS
and CSS; no source-policy exception or production dependency is introduced.


## Quiet Skills and bounded direct Add

The accepted polish uses shared explorer header bands and accessible instruction/agent/copy
symbols while retaining independent browsing, explicit submitted search, match-source evidence
and all previous failure scenarios. The small standalone concept is a visual reference only;
its simplified search handlers were not adopted. Search rows keep their richer source context.

Activate a library skill to see project/agent/mode immediately beneath its title. **Add to project**
prepares and applies only an unchanged accepted source hash at the exact absent destination.
It does not open a second modal for that create-only case. Existing copies, changes, removal,
original conversion, routers and approval still use their existing reviews. After verified sample
success, Remove from project remains available with current-target protections, not universal Undo.
The declared-runtime-prerequisite fixture deliberately stops direct Add and offers explicit review;
its requirements remain visibly unchecked on the host. No probe is invented.

Instructions has one Rendered/Source toolbar and a whole-body disclosure. The viewer owns scrolling;
only rendered prose has a line-length limit. Collapse/expand retains the same tab's mode and reading
position without another read. Details retains exact host-qualified source and status. Settings uses
aligned fields, a quiet connected-library row and collapsed details; disabled retains the enable field.

The Release polish fixture controls are outside the illustrated app. Refresh retained observations
starts a finite delayed sample check; its failure switch supplies an unavailable observation while
retaining the list. Activity uses fixed header controls. Initial metadata loading has its own scenario,
without an empty-library claim. The theme control supports dark/light inspection. These controls only
supply page-memory observations, never runtime authority, filesystem effects or an extra polling loop.

`polish-check.mjs` extends the same headless browser lifecycle with focus/scroll stability, stale/error
retention and replacement context, nonzero body-position collapse/expand, responsive light/dark layout,
direct Add and compact removal. Its pure owner cases cover hash/approval/target/context changes,
accepted pinned creation, unchecked remote requirements and retained uncertainty. These are study
contracts; production CLI, transport, capacity and mutation guarantees need their separate owners.

## Explicit reading and search refinement

Select **Reading / three installed skill pairs**. The fixture declares three proven logical
identities, each with an original and an accepted canonical library occurrence. Their versions
differ deliberately. Submit an empty query: all three installed identities are hidden, with a
clear explanation and **Include installed** action. Including them returns three canonical group
representatives. **Show separate copies** returns the six sourced occurrences; their row menus
retain the same applicable actions. These are returned sample rows, not a global match count.

Query `original-only` with Include installed and grouping on. Each preferred canonical result
explicitly identifies the matching original and says that its own definition did not match.
Show separate copies expands the matched proven group to all eligible occurrences, retaining
that evidence on a canonical occurrence whose own content did not match; legacy search keeps
its independent occurrence-match semantics.
Changing an Advanced draft leaves the submitted result labels intact until the next search.
**Preferred agent** never narrows all-agent installed exclusion. Pending canonical edits exclude
that canonical candidate; an eligible original may represent the proven group. No older accepted
Git body is retrieved. Equal names and unknown/conflicting identity links do not establish groups.

Activate original and canonical rows to compare their labeled current files. The fixture panel
reports only the count of explicit sample reads and can delay one read. Expansion, refresh and
focus leave that count unchanged; leaving the tab, disabling or changing context rejects late
completion. Pending project instructions remain readable. Converting one sample to Stub and
activating the result shows stub instructions; activating a router shows its own routing body.
Review content and Accept retain their separate complete-tree flow and do not run on activation.

The unknown-presence scenario offers **Search including installed…**, retaining supported
grouping while bypassing only the unavailable installed filter. An unsupported contract instead
offers **Search with installed Skillager…** explicitly, including installed skills and retaining
the actual agent preference. Older Skillager may group agent variants; this fallback does not
promise the new separate-copy contract. They do not claim a
version number establishes support. Local library candidate approval is separate from selected
project-presence observation. SSH search remains local; only proven identities from hvir-owned
remote delivery observation may exclude installed groups before CLI ranking. This offline study
illustrates those boundaries and cannot prove real discovery, confinement, transport, installed
CLI compatibility, aggregate completeness or 5,000-source performance.

## Exercise the decisions

- Start disabled: the app shows no Skills navigation, placeholder, controls, badges, or retained
  content. Only Settings offers Enable Skillager. Enabling reveals connection settings without
  granting access or reopening a prior feature viewer.
- Select Missing CLI to see selectable `uv tool install skillager` guidance in enabled Skills
  and Settings. Check again preserves that missing sample. The separate “CLI available externally”
  study scenario supplies a successful probe fixture; Check again then returns to explicit library
  connection without connecting automatically. The study never installs anything.
- Select First use · create personal library to see the visible local default location and
  Keep Git history enabled for the personal library. Choose folder opens a labeled sample picker,
  changing only that local selection; it is not an OS picker or filesystem grant. Create and
  connect shows progress, then the verified sample library opens directly with first-skill guidance.
  The readonly agent prompt leaves a draft pending for review and never injects terminal input.
- The Git-failure scenario preserves the actual sample error and uncertain effects. Check library
  status reconciles the external fixture before offering another initialization. The existing-mode
  scenario shows the actual Git mode and requires explicit connection instead of silently changing
  the choice. Disable during setup cancels its timer and rejects late publication; re-enable
  preserves the need to check status without restoring a connection or viewer. Unavailable status
  keeps effects uncertain and offers no new initialization. The SSH-workspace
  example still initializes the local personal library only. All effects are page memory.
- Empty-library guidance requires an observed empty personal inventory. A no-match search keeps
  its search state, not the onboarding prompt. Existing errors and unavailable states remain distinct.
- Enable Skillager in Settings and connect the exact displayed local library. Changing its
  identity/location requires reconnecting; review, acceptance, and exposure then name that selected
  source. Ordinary content review does not require reconnecting.
- Switch Files/Git/Skills independently of open viewer tabs. Activate a sidebar row or retained
  detail tab to read its actual current file; focus, expansion, search arrival and refresh do not
  read bodies. Review content separately prepares the verified sample snapshot. Closing or leaving
  a tab revokes its read; activating it again starts a new current read. A source change never
  relabels old bytes as newly accepted. Closing a skill tab preserves a visible sidebar.
- Disable during search, a preview, or a notification. Feature requests and timers stop, its
  tabs/dialogs/toasts disappear, and the sidebar returns to Files if needed. The last ordinary
  viewer and terminal/session content remain. Re-enabling starts disconnected, without old tabs.
- Submit `deadlock` in the sample search scenario. It illustrates title, description, and
  body-only metadata matches, external ownership, loading, cancellation, the submitted query beside
  results, the 50-row window, and the 50,000-character accepted-body boundary. The eight-row
  synthetic dataset proves no scale or CLI behavior. This dedicated mixed-match scenario explicitly
  enables Include installed; the normal search default keeps it off.
- Add an accepted version to the displayed absent worktree/agent target directly, with the existing
  exact preview/apply checks inside that action. Change mode or remove an exposure through the
  separate review naming source version, destination, existing state and every sample effect. Protected targets
  cannot be replaced or removed through ordinary actions. Unmanaged presence has no recorded mode
  or version; source policy blocks remain distinct from the existing exposure's state. Changing
  destination or agent revokes a prepared dialog; a changed source version refuses apply.
- Accept library changes and observe that the old workspace copy stays behind. Update that copy
  as a separate action. Remove a copy and confirm its library row remains.
- Select Existing project skills · terminal setup. This workspace shows approved, pending,
  lint-blocked and explicitly blocked native metadata with source-agent labels separately from
  managed copies. Native row activation reads approved, pending or blocked current instructions without approving
  them. Details offer discoverable Use as full skill…, Use as stub… and Router actions
  with a preservation prerequisite when conversion is unavailable; source approval remains distinct
  from canonical-library acceptance.
  The metadata can appear before setup. Zero-row copy reports what Skillager returned; it cannot
  prove every folder was readable. A separate unavailable example preserves that distinction.
- Set up in terminal identifies the selected local project and agent, then creates a new terminal
  illustration through a revocable one-use handoff. It never launches a real shell or sends input.
  The existing terminal and ordinary viewer remain available. Controls outside the app shell
  supply synthetic observed completion outcomes and simulate terminal recovery; their labels are
  illustrative, not claims that every installed public schema distinguishes each state. Exit zero does not imply
  readiness or Working installation. The Ready fixture includes resolved pending/lint metadata;
  explicitly blocked metadata may remain. Successful setup hides its card; a compact explicit
  setup control remains. Skillager, not hvir, owns those decisions.
- Disable before the simulated handoff to reject its late callback. Disable afterward to preserve
  ordinary terminal content while feature observation disappears. Changing project/agent prevents
  stale completion from publishing readiness, and terminal recovery never replays setup. Public
  metadata refresh remains read-only with respect to approval, Working and exposure effects.
- Select Project skills explorer to browse concise agent-qualified rows immediately. Project and
  library sections remain independently accessible; a long project list cannot bury the library.
  Expand public router membership or a provided source-to-copy relation without reading bodies.
  Equal display names alone never create a relationship. Review/Conflict/Update labels stay visible
  when names and secondary agent text truncate.
  Search starts collapsed; its first level contains query and submit, while Advanced contains scope,
  Preferred agent and coverage. All agents does not silently choose an action agent. Same-named
  Codex and Claude copies retain distinct identities, and changing the search preference preserves
  every project browse row and open details. Submitted results are not filtered afterward or merged from separate limited queries.
- The curation scenario’s row action trigger, context menu and details action expose the same
  Use as full skill…, Use as stub… and Router choices. Ordinary row activation shows the actual
  Project original, Installed Full, Installed Stub or Installed Router current file. A separate
  Open library definition action selects the proven canonical relation. Review content opens its
  own retained canonical sample; ordinary reading cannot satisfy that review. Unpreserved native
  removal still hands off to Files without canonical acceptance authority. Converting
  a native source requires an approved version already preserved in the chosen library; extra
  original files, stale approval, conflicts and unsupported capabilities refuse with a reason.
- Sync approved skills is visible in an actually empty personal inventory and lives in compact
  Library actions after it is populated. Explicit backfill reports created, updated, unchanged,
  conflict, skipped and failed source outcomes; lost completion requires read-only observation
  before another explicit sync and does not invent prior operation history; it does not convert originals. The separate external
  approval fixture illustrates subsequent sync publication. Every verified approved copy becomes
  reusable across projects, including project-only originals; advanced lineage retains the actual
  original scope/evidence. Refresh, expansion and browsing never sync.
  Opening or canceling empty-library backfill preserves the observed inventory; only confirmation
  publishes the supplied sync result. Pending or blocked canonical edits remain unaccepted after
  explicit backfill or approval-triggered sync.
- Group in router offers an editable New router name or an existing provided named group.
  Select whether the exact standalone copy should be replaced, then review the returned tag,
  members and all sample file effects before confirming. New-name conflicts require a fresh choice.
  Existing groups use their provided identities and a complete membership plan; changing a tag
  shared with another agent/router refuses. Edit members chooses Full, Stub or Remove from project
  for departures; removal creates no standalone copy or new approval.
  A previously retained standalone copy stays in place when its router membership is removed.
  A different requested restoration mode refuses rather than silently adopting that copy. Absent
  members disclose that no standalone copy exists to remove.
  Ungroup chooses the standalone mode, removes the router and retains the tag’s curated members.
  Unselected copies and unrelated groups remain. External source/member changes refuse old plans.
  An interrupted outcome stays uncertain; explicit sample observation can report retained originals
  and required recovery without claiming a completed conversion or offering an automatic retry.
- Library-only entries offer Add to this project with a concrete agent/mode choice. Their canonical
  acceptance remains independent of original drift/block/sync conflict. Pending canonical edits stay
  pending; unchanged managed removal uses target protection and leaves those pending edits intact.
  Only native adoption/removal requires the current original-to-canonical preservation proof. Managed Update
  shows the old project version and accepted library version. Approved native removal previews its
  complete original effects and preserved canonical version, retaining unselected agent copies.
  Unwanted pending or unpreserved originals offer Remove in Files: reveal the exact current-project
  folder, then use a separate existing Files confirmation with the host's actual recovery guarantee.
  This sample illustrates local recoverable Trash; no real OS operation runs and no approval occurs.
  Ordinary viewer/terminal content stays intact. The study does not prove Files' production dirty
  buffer checks, platform recovery behavior or actual filesystem token validation.
  The synthetic app has one shared dialog; it does not model simultaneous Files and Settings dialogs.
- Select SSH: Your library remains available; workspace catalog search and Stub are unavailable.
  The same Add, Update, and Remove flows show local approval/export from Skillager and SSH
  observation, delivery, and safe destination management by hvir. Remote previews distinguish
  workspace files from hvir's deployment-record effects; they do not install Skillager sidecars.

Skillager owns local approval/identity and a transport-neutral verified Full skill export, without
SSH credentials, paths, observation, or mutation APIs. hvir owns remote records/fingerprints,
transfer, safe publish/update/remove, reconciliation and cleanup through ProjectHost. Remote
records describe hvir delivery, not Skillager trust state. This study chooses no production record
format or storage path. The generated page is not evidence that the production export or destination-management
contracts are implemented; their implementation and acceptance belong to issue/PR records. Existing transfer primitives alone do not
prove safe replacement, and ordinary Files collision policy remains unchanged.

Skillager is user-installed and user-managed, as documented by its
[quickstart](https://github.com/jarmak-personal/skillager#quickstart) and
[PyPI project](https://pypi.org/project/skillager/). hvir does not bundle or manage the CLI as a
dependency, install/upgrade it, bootstrap Python/uv, change PATH or package environments, execute
package managers, or inject commands into existing terminals. The named project setup handoff
authorizes one command in a new user-controlled local terminal; the offline study never executes it. Missing, selected-path, unsupported-contract, and
command-failure states remain distinct design contracts; this sample illustrates missing and
externally available CLI states plus synthetic library-init success/failure outcomes. Existing
opt-in contributor fixtures do not grant application installation authority.

Curation scenarios do not implement CLI schema validation, trust derivation, real approval/sync,
file preservation, locking, rollback, OS Trash, dirty buffers, or token verification. Their in-memory snapshots illustrate
invalidation and their file effects describe a small declared sample tree. Name normalization is a
simulated public reply; production must consume the CLI’s returned name. The accepted bounded
native/router request and approved-source sync contracts are governed by #780/#781; these
fixtures do not assert support in an installed CLI.
Existing managed router-only removal is reused separately from whole-group conversion: it removes
the router without creating standalone copies and retains the tag. The shared runner’s focused curation journey tests browser interaction with those
fixtures, including keyboard/physical actions and normal/compact layouts; it proves no upstream
contract or filesystem safety.

Run the focused real Chromium check after generating the artifact:

```sh
node scripts/skillager-study/check.mjs /tmp/hvir-skillager-study
```

It uses an isolated headless Chrome profile, observes process completion from launch, bounds
termination waits, removes its profile, and writes `validation.json` plus initial-off, onboarding,
sidebar, explicit-review, disabled-after-search, and compact screenshots beside the artifact. Set
`HVIR_STUDY_CHROME` to an explicit local Chrome or Chromium executable on other systems. The opaque `allow-scripts` iframe check proves this
self-contained page renders in that browser sandbox. It does not establish hvir's response-header
CSP, Electron lifecycle, terminal responsiveness, or SSH transport behavior.

Refresh eligibility is checked at its pure enable/connection/sidebar/viewer/visibility/focus gate.
The browser runner observes actual periodic timer acquisition/release without changing the clock,
and replays actual canceled search and setup callbacks to prove late publication is rejected. Browser
checks exercise separate sidebar/viewer selection and real tab focus changes where Chromium
exposes them, plus terminal/session content and geometry preservation. The project setup journey
is maintained in its focused checker module; all terminal handoff effects there are synthetic. The report discloses
unsupported background observations. It does not wait through a real 60-second periodic interval.

## Real CLI contract evidence

Prepare the immutable Skillager v0.9.0 source at
`fda8f4da442b8165cc34ac62e626b76920a90838` in a separate temporary checkout/archive, then run
`uv sync --locked` there. Do not change the user's checkout or installed tool. Pass that isolated
release directory to the opt-in contract probe:

```sh
node scripts/skillager-study/contracts.mjs /path/to/isolated/skillager-release
```

The probe uses the release's `.venv/bin/python` and public CLI in fresh disposable Git and no-Git
library/project/home/config/cache roots. All library approvals, exposures, and removals affect
only those fixtures. It tests actual JSON shapes, stale-token refusal, accepted versus pending
content, Git diff endpoints, metadata-only history/stat, exposure listing, dry-run limitations,
acceptance preserving a workspace copy, and removal preserving the library. It prints a bounded
command/schema/status report with opaque tokens redacted and disposes its fixture roots.

For the large catalog use the release-owned benchmark, which registers and approves generated
content through the public CLI rather than forging trust records:

```sh
uv run --project /path/to/isolated/skillager-release \
  --directory /path/to/isolated/skillager-release \
  python scripts/benchmark_search.py --sizes 5000 --repeats 5 \
  --output /tmp/skillager-search-report.json
```

That workload contains 5,000 approved skills plus two pending drafts, with four owned approved
skills and 4,996 approved external collection skills. It verifies title/description/body-only
matches, ranking, scope before limit, pending exclusion, metadata-only output, and exact-hash
edit/reacceptance. First search includes index construction after fixture setup; OS caches are
not flushed. Repeated samples start fresh CLI processes. This is not 5,000 individually accepted
owned skills, library Git performance, production relevance, Electron responsiveness, or SSH.

Search admission selected in ADR-046 is 1,000 UTF-8 query bytes, 50 rows, 4 MiB stdout, 64 KiB
stderr, a 30-second deadline, one query per viewer generation, and at most two CLI processes
application-wide. These are consumer requirements, not claims that v0.9.0 enforces every bound.
Execution aborts or reports unsupported data rather than parsing partial output.

Implementation observations, measurements, remaining upstream contract gaps, and acceptance
results belong to issue #778 and its focused pull request. ADRs record decisions only.
