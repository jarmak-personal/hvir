# ADR-050: Extension contributions, updater demand, and finite action lifetimes

> Lifecycle: Active

## Context

Extensions need visible workspace and application navigation and small terminal observations
without gaining terminal control. One observation can serve several rows. A named action must
retain its admitted caller and target when selection or visibility changes.

## Decision

The existing contribution placement owner admits workspace left-rail views, independent
application destinations, and declarative terminal header/session items. Static items require
no guest. hvir owns accessible placement, popup bounds, dismissal, and focus return. Popup focus
does not clear terminal attention. Removed contributions return navigation to a built-in view.

An active installation may declare one updater entry. The existing sandboxed guest boundary
hosts at most one updater per active installation across renderer owners. Its exact old guest
is revoked before replacement hosting on renderer turnover. Trusted visible
contribution demand controls its runnable lifetime, including an ordinary viewer with a compact or collapsed rail. The existing trusted presentation seam qualifies updater demand by foreground independently of D2 placement/native visibility. Settings obscuring hides ordinary placement and excludes its refresh demand; several session rows share it. Compact,
collapsed, hidden, or background surfaces supply no demand. Closing a popup removes its own
demand only. No demand freezes execution and denies refresh; renewed demand publishes current
context before runnable work resumes. Updaters can observe context and publish presentation,
but cannot open views, invoke actions, mutate files, or hand work to terminals.

A focused presentation owner validates finite data: bounded glyph icons, short labels and
tooltips, observation availability and timestamps. Application control values may persist under the
extension state-write lease. Observation publications remain in memory, avoiding periodic
cache writes; any restored observation is stale. Saved presentation is untrusted cache: invalid
entries are discarded and clock rollback cannot prevent platform startup or forgetting setup. Session values are tied to
an exact live PTY instance and renderer generation and end on its revocation. Existing session,
project, and PTY owners provide metadata through read-only ports, without another session registry
or Sessions destination demand. No terminal content, process handle, or control callback is public.

Exported actions name an ordinary declared view and declare agent access and delete/replace
effects. These declarations confer no capability or trusted decision. A focused action owner
pins request identity, activation, caller class, authorization mode, and exact workspace/session
context. hvir opens the named view through normal placement without taking keyboard focus.
The bridge delivers a bounded invocation and accepts its correlated result. Selection cannot
retarget it. Hidden views deny refresh but remain runnable for their finite admitted invocation;
closing or context revocation cancels it. The existing one-in-flight native lifecycle driver
combines visible refresh demand and finite admitted action work, rather than adding an engine.
Agent authorization and native connectors remain separately owned by later decisions.

Each installation has at most eight views, eight rail items, and eight actions; the application admits at most thirty-two views. Presentation
subscriptions and updates use the existing bounded bridge. Per-view/extension/application request
and rate limits remain enforced. Actions permit four concurrent invocations per extension,
sixteen globally, 8 KiB input/result, and a default 120-second deadline, with an optional declared deadline of 1–180 seconds.
The finite bound permits supported later CLI actions whose measured runtime exceeds one minute. Context contains at most 128 live
sessions within a 7 KiB public context bound, leaving room for an 8 KiB action input and bridge envelope. Hidden subscriptions retain current data without queueing updates; resume publishes that current snapshot. A failed updater marks its observations failed and remains latched while its hosting renderer generation is live. Explicit activation revision or disable/enable recovers it; revoking that exact hosting generation also permits successor hosting after old physical disposal drains. Forgetting platform setup removes that installation's saved presentation under the existing writer transaction. Persisted presentation is at most 16 KiB per installation and 256 KiB globally.

Disable, replacement, renderer turnover, writer loss, and exit revoke authority before native
disposal. Dependent workspace/session work ends independently; application contributions survive
workspace selection changes. Existing deferred native teardown, per-view disposal receipts, and
physical closing capacity remain authoritative.

## Consequences

Visible observations do not require popups or one runtime per row. Finite actions have ordinary
close controls and stable provenance. Bounded refusal and stale/unavailable states stay visible.
Hidden admitted work may execute timers until its finite deadline; it gains no refresh authority.

## Rejected alternatives

- Running package code in rail rendering grants workbench authority.
- One updater per item/session duplicates resources and grants invisible background work.
- Recycled Sessions projection handles cannot identify an exact live action target.
- Cancelling work on hide breaks finite actions; leaving every hidden guest runnable permits refresh.
- A second guest engine or a general background task framework duplicates lifecycle authority.
