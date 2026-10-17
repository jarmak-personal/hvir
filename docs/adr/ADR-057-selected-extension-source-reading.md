# ADR-057: Selected extension source reading

> Lifecycle: Partially superseded
> Superseded by: [ADR-068](ADR-068-in-context-human-source-read-decisions.md) | partial | Settings-only application-local read-only root decision surface only.

## Context

An ordinary extension can obtain source locations from an explicitly approved native
connector, but execution conveys no filesystem authority. A personal library is an
application-local source independent of project registration and workspace selection.
Reading pending instructions must neither approve them nor expose their bodies to agents.

## Decision

The public manifest declares named read-only document scopes: an application-local root
or one exact registered workspace. Trusted Settings chooses a live registered workspace
identity through the existing context catalog and explicitly grants its canonical host-qualified
root. Workspace grants persist that identity and root, cover no other present or future
workspace or host, and end when registration, root or connection changes. Application grants
remain explicit canonical local roots. The source-access
owner persists grants through the existing extension writer. Grants bind installation and
the complete declaration; unchanged declarations reuse grants after explicit revision
acceptance. Discovery, reported paths, initial view input and native approval confer no read
permission. Forgetting platform setup removes its grants and preserves external content.

A visible ordinary view explicitly selects one source within a current grant. Main pins
its activation, caller/view, canonical root, host, exact workspace where applicable and
selected file, then reads bounded current UTF-8 text through ProjectHost. Selection returns
an opaque caller-bound receipt with an absolute five-minute lifetime; bounded text pages
revalidate the same authority. Pages fit the complete bridge envelope, including worst-case
JSON escaping, and the existing message-rate cap permits a maximum text or image transfer
within that lifetime. Revoked in-flight reads keep their physical reservations until the
underlying host read settles. Metadata
browse, focus, opening and refresh do not select or prefetch bodies. Replacement selection,
view closure, disable, revision replacement, grant revocation, workspace closure, host
disconnect and writer loss invalidate late results. Application reads do not inherit the
active workspace. No human-click outside-project exception is borrowed.

Body operations deny update runtimes, every action invocation and restricted agent-origin
views, including unrestricted local agent origins, independently of request-supplied invocation identity. Opening the caller's own
declared contribution may carry bounded data-only initial input, qualified by the existing
context and origin. Input stays within 6144 encoded bytes under the existing 7 KiB context and 16 KiB message bounds; optional repeated root metadata is omitted when needed. View reuse retains the main-owned origin intersection; initial input
cannot grant source access or convert an agent origin into a human origin. Core contains no
tool-domain metadata, scanner, acceptance engine or private-state reader.

`source.render` derives bounded safe HTML only from an existing selected-human receipt,
under the same main-owned origin, grant, visibility and absolute lifetime. The existing
pure document Markdown policy moves to a shared presentation leaf; the trusted renderer
worker continues consuming it. A document-owned adapter reuses the established utility-process
mechanics: one lazy process, one physical parse, no queue/cache/host calls and at most
512 KiB of returned HTML. Revoked or timed-out callers retain physical parse admission until
the underlying RPC settles; failed/disposed processes are not replaced inside that owner.
Application disposal ends the worker lifetime. Render overflow falls back to the complete
current Source bytes, never partial rendered instructions. The selected-source resource mode
keeps external links inert and emits confined-image placeholders, independently of parsing.
Guest CSP retains worker-src 'none'; no general guest-worker capability is introduced.

The maintained Skillager package consumes its public CLI inventory, paginated search and
source metadata, then the selected-source contract. Its safe guest Markdown reader disables
raw HTML, uses the bounded selected-source rendering adapter and confines requested relative images to the selected document directory within
the same grant. It preserves current Stub, Router, Full, original and library selections;
it never substitutes accepted history or another occurrence. Current text is not proof of
accepted tree bytes. Canonical jumps are separate selections requiring public library UUID
and skill identity or validated lineage. CLI-owned grouping, filtering and ranking occur
before limits. Unsupported current contracts produce a supported refusal without a legacy
fallback.

The donor [project explorer decision](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-049-project-skill-explorer-and-curation.md)
and [explicit reading decision](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-050-explicit-skill-reading-and-search-defaults.md)
supply source truth, confinement and separation of reading from acceptance. Their built-in
sidebar ownership, private integration and legacy search fallback do not govern this package.

Public contracts depend only on shared data leaves. Guest packages depend only on public
contracts, the public presentation kit and their domain code. Guest admission delegates to
the named source and connector owners; composition roots wire their ports. Existing package
direction enforcement and ordinary source budgets govern this boundary without relaxation.

## Consequences

Personal-library reading works independently of workspace setup and mutation grants.
Selection receipts and bounded retained bytes add an explicit finite resource lifetime.
Read grants do not confine approved native tools or constitute OS sandbox authority. Current
files may change after observation, so the reader reports its read time and current-file
identity without attributing historical acceptance to new bytes.

## Rejected alternatives

- Treating a connector result, initial view input or human external-read exception as access.
- Requiring library project registration or content acceptance before reading.
- Body prefetch on browse, refresh or focus, and agent-callable instruction-text actions.
- Porting trusted donor integration or introducing a second scanner or search engine.
- Raw HTML, unconstrained image paths or network resources in instruction presentation.
