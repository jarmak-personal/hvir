# Skills interaction study

This maintained, offline study illustrates the accepted interaction in ADR-046. Its original
reference was the user-owned `skillager-integration.local/` study; those originals remain
untouched. The dark palette, viewer/terminal split, and representative skills are retained.
Skills is a left-sidebar peer of Files/Git: metadata browsing and submitted search live on the
left, selected details and explicit body review use the normal main viewer. The study harness
and scenario controls sit outside the illustrated app shell.

Generate a standalone HTML file from the maintained sources:

```sh
node scripts/skillager-study/build.mjs /tmp/hvir-skillager-study
```

Open the printed `index.html` in a browser or hvir's HTML viewer. It needs no server, CLI,
network, real library, or file-write permission. Every displayed path, hash, instruction, and
terminal is sample data. All management actions mutate page memory only. Reset restores the
initial disabled state. The scenario selector loads independent examples, including connected,
missing CLI, empty, stale preview, protected targets, remote delivery, and unavailable freshness.

The source model owns only illustrative state; views produce markup; the browser entry owns
DOM events and page timers. The builder uses the declared Vite dependency to bundle these modules
and stylesheet into a single self-contained artifact outside the maintained tree. Generated HTML,
screenshots, and run evidence are not committed. Ordinary source and dependency checks cover the maintained JS
and CSS; no source-policy exception or production dependency is introduced.

## Exercise the decisions

- Start disabled: the app shows no Skills navigation, placeholder, controls, badges, or retained
  content. Only Settings offers Enable Skillager. Enabling reveals connection settings without
  granting access or reopening a prior feature viewer.
- Select Missing CLI to see selectable `uv tool install skillager` guidance in enabled Skills
  and Settings. Check again preserves that missing sample. The separate “CLI available externally”
  study scenario supplies a successful probe fixture; Check again then returns to explicit library
  connection without connecting automatically. The study never installs anything.
- Enable Skillager in Settings and connect the exact displayed local library. Changing its
  identity/location requires reconnecting; review, acceptance, and exposure then name that selected
  source. Ordinary content review does not require reconnecting.
- Switch Files/Git/Skills independently of open viewer tabs. Select metadata from the sidebar,
  then use Review content to read the chosen snapshot. Closing a skill tab preserves a visible
  sidebar; switching to another skill never carries forward body-review access.
- Disable during search, a preview, or a notification. Feature requests and timers stop, its
  tabs/dialogs/toasts disappear, and the sidebar returns to Files if needed. The last ordinary
  viewer and terminal/session content remain. Re-enabling starts disconnected, without old tabs.
- Submit `deadlock` in the sample search scenario. It illustrates title, description, and
  body-only metadata matches, external ownership, loading, cancellation, the submitted query beside
  results, the 50-row window, and the 50,000-character accepted-body boundary. The eight-row
  synthetic dataset proves no scale or CLI behavior.
- Add to a selected worktree and agent, change mode, or remove its exposure. The preview names
  source version, exact destination, existing state, and every sample effect. Protected targets
  cannot be replaced or removed through ordinary actions. Unmanaged presence has no recorded mode
  or version; source policy blocks remain distinct from the existing exposure's state. Changing
  destination or agent revokes a prepared dialog; a changed source version refuses apply.
- Accept library changes and observe that the old workspace copy stays behind. Update that copy
  as a separate action. Remove a copy and confirm its library row remains.
- Select SSH: Personal library is the default; workspace catalog search and Stub are unavailable.
  Full-skill staging and management are simulations of the accepted future contract.

Skillager is user-installed and user-managed, as documented by its
[quickstart](https://github.com/jarmak-personal/skillager#quickstart) and
[PyPI project](https://pypi.org/project/skillager/). hvir does not bundle or manage the CLI as a
dependency, install/upgrade it, bootstrap Python/uv, change PATH or package environments, execute
package managers, or inject terminal input. Missing, selected-path, unsupported-contract, and
command-failure states remain distinct design contracts; this sample illustrates missing and
externally available CLI states only. Existing opt-in contributor fixtures do not grant application
installation authority.

Run the focused real Chromium check after generating the artifact:

```sh
node scripts/skillager-study/check.mjs /tmp/hvir-skillager-study
```

It uses an isolated headless Chrome profile, observes process completion from launch, bounds
termination waits, removes its profile, and writes `validation.json` plus initial-off, sidebar,
explicit-review, disabled-after-search, and compact screenshots beside the artifact. Set
`HVIR_STUDY_CHROME` to an explicit local Chrome or Chromium executable on other systems. The opaque `allow-scripts` iframe check proves this
self-contained page renders in that browser sandbox. It does not establish hvir's response-header
CSP, Electron lifecycle, terminal responsiveness, or SSH transport behavior.

Refresh eligibility is checked at its pure enable/connection/sidebar/viewer/visibility/focus gate.
The browser runner observes actual periodic timer acquisition/release without changing the clock,
and replays an actual canceled search callback to prove late publication is rejected. Browser
checks exercise separate sidebar/viewer selection and real tab focus changes where Chromium
exposes them, plus terminal/session content and geometry preservation. The report discloses
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
results belong to issue #778 and its focused pull request. ADR-046 records decisions only.
