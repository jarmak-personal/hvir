# ADR-094: Search the current native terminal buffer

> Lifecycle: Active
> Supersedes: [ADR-091](ADR-091-native-retained-query-authority.md) | partial | Search source selection and query lifetime across normal/alternate screen transitions.

## Context

Terminal search must find text in the terminal buffer the user is interacting with.
The normal-buffer-only choice in [ADR-091](ADR-091-native-retained-query-authority.md)
excludes text displayed by harness TUIs that use the alternate screen. Searching hidden
normal-buffer history while reporting no matches for visible TUI text is misleading.

Buffer activation and content identity are different lifetimes. A terminal may switch
from normal to alternate and back without replacing normal-buffer storage or changing
its text. Observing the same screen key or page generation later does not establish
that a query still belongs to the current interaction.

## Decision

Search one native buffer per query: the normal screen and its retained scrollback when
the normal screen is displayed, or the alternate screen's current contents when the
alternate screen is displayed. Capture that source in the authoritative native Terminal
at query admission. Do not combine matches from the current and hidden buffers.

Bind query, occurrence, query-read and selected-highlight authority to the captured
buffer and a monotonic parser-owned activation epoch, in addition to their existing
storage and affected-cell identity. Advance the epoch on every actual screen transition.
A normal-to-alternate-to-normal round trip invalidates prior query authority even when
the original buffer and its text survive unchanged. Epoch exhaustion fails closed rather
than wrapping to a previously issued identity.

A transition invalidates the current query and its occurrences. Existing query updates
and the search controller restart the same text and case option against the newly
displayed buffer, without retaining the old selected occurrence. Subsequent lookup,
reveal and read operations, including completion of an unfinished read, refuse authority
from the previous activation. Retire the old selected highlight; late completion must
not paint it on a new activation.

Keep matching, buffer selection, occurrence metadata, exact extraction and highlight
validation in the existing native owners. Preserve literal UTF-8 matching, explicit case
sensitivity, oldest-row then left-to-right order, overlapping matches, hard-break and
soft-wrap semantics, bounded native continuations and the existing query-byte admission
bound. The renderer retains query intent and one selected occurrence, not terminal text
or a complete result list.

This decision replaces only ADR-091's normal-buffer-only source and its preservation of
query occurrences across alternate-screen presentation. Its native ownership, work and
storage accounting, affected-cell identity, semantic-boundary meaning, cancellation,
cleanup and clipboard-authority rules remain in force. Semantic ranges keep their own
source and lifetime; they do not inherit search activation invalidation.

## Consequences

Search finds retained normal output and currently displayed TUI text through the same
pane capability. Buffer transitions restart the query and clear its selection rather
than silently returning matches from a hidden buffer. Native query consumers must accept
both screen identities and reject invalid or stale metadata.

Alternate-screen search covers only text retained in that native buffer. A harness's
internal conversation history that it has not rendered is not a terminal text source;
search does not send harness commands to retrieve it.

The native parser, query/read owners and renderer highlight owner share activation
identity. This adds no transcript mirror, input FIFO, background search service, total
history limit, match-count ceiling or productive-copy cap.

## Rejected alternatives

- Normal-buffer-only search, which omits visible alternate-screen TUI text.
- Combining hidden normal history and alternate-screen results, which gives one query
  multiple sources and an ordering unrelated to the displayed buffer.
- A renderer transcript, second parser or complete result mirror, which duplicates native
  text and authority.
- Screen-key or page-generation checks alone, which cannot detect a transition back to
  the same surviving buffer.
- Waiting for output quiescence or a new frame before establishing search source, which
  confuses parser state with presentation and can starve an active harness query.
