# Skills interaction study

This maintained, offline study illustrates the accepted interaction in ADR-046. Its original
reference was the user-owned `skillager-integration.local/` study; those originals remain
untouched. The same dark palette, viewer/terminal split, sidebar launcher, and representative
skills are retained. The revised surface adds the accepted opt-in connection, exact source and
destination, submitted search, remote scope restriction, review distinctions, and refresh rules.

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
DOM events and page timers. The builder bundles these explicit modules and stylesheet into a
single self-contained artifact outside the maintained tree. Generated HTML, screenshots, and
run evidence are not committed. Ordinary source and dependency checks cover the maintained JS
and CSS; no source-policy exception or production dependency is introduced.

## Exercise the decisions

- Enable Skillager in Settings and connect the exact displayed local library. Changing its
  identity/location requires reconnecting; ordinary content review does not.
- Switch among Skills, the document, and Git history. Close and reopen Skills while the terminal
  and session rail remain below the viewer.
- Submit `deadlock` in the sample search scenario. It illustrates title, description, and
  body-only metadata matches, external ownership, loading, cancellation, the 50-row window, and
  the 50,000-character accepted-body boundary. The eight-row synthetic dataset proves no scale
  or CLI behavior.
- Add to a selected worktree and agent, change mode, or remove its exposure. The preview names
  source version, exact destination, existing state, and every sample effect. Protected targets
  cannot be replaced or removed through ordinary actions.
- Accept library changes and observe that the old workspace copy stays behind. Update that copy
  as a separate action. Remove a copy and confirm its library row remains.
- Select SSH: Personal library is the default; workspace catalog search and Stub are unavailable.
  Full-skill staging and management are simulations of the accepted future contract.

Run the focused real Chromium check after generating the artifact:

```sh
node scripts/skillager-study/check.mjs /tmp/hvir-skillager-study
```

It uses an isolated headless Chrome profile, closes its process, and writes `validation.json`
and a compact screenshot beside the artifact. Set `HVIR_STUDY_CHROME` to an explicit local Chrome
or Chromium executable on other systems. The opaque `allow-scripts` iframe check proves this
self-contained page renders in that browser sandbox. It does not establish hvir's response-header
CSP, Electron lifecycle, terminal responsiveness, or SSH transport behavior.

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
