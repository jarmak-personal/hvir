# ADR-066: Declared extension installation landing

> Lifecycle: Active

## Context

Explicit installation should reveal an extension's useful content without requiring users
to find a second navigation control. Ordinary application views already own that content.
Installation from Settings can happen while unrelated application preferences are unsaved,
and asynchronous preparation can outlive the initiating user intent.

## Decision

A manifest may name one optional `landing` identifier from its own ordinary application
views. Resolve only that declaration after explicit installation commits and its first-use
connection continuation settles, including declined or unavailable connection. Absent
metadata leaves the ordinary installed controls available. Discovery, startup, reload,
reconnect and background work do not navigate.

The installation owner retains its exact committed activation receipt and source binding
in main. Check the committed receipt's accepted revision once, then prepare through the
existing guest owner without selection or focus. Revalidate the exact active object and
physical captured source, renderer, live continuation and native foreground before and
after asynchronous preparation. Return only the bounded installed identity and optional
existing prepared view descriptor, paired with its newly-created versus reused ownership.
If final admission or synchronous renderer consumption refuses, close only preparation
created by this Add through the existing guest owner and close-view transport. Preserve
reused views. No additional acknowledgment registry, placement or grant is introduced.

The renderer matches its existing Add request immediately before synchronous selection
through the existing top destination or ordinary viewer owner. Genuine departure cancels
the continuation. Deferred guest focus belongs only to the exact still-selected, visible
view and fresh native foreground. Retire the bounded hint on genuine foreground or
presentation withdrawal, even before its first visible attempt and when publications are
batched; ordinary return cannot replay it. Preparation alone arms no focus hint.

During this deliberate handoff, retain the existing Settings controller and its unsaved
application draft, including invalid editable strings. Retire the hidden dialog DOM,
section resources, subscriptions, keyboard listeners and pending focus frames. Reopening
Settings resumes that draft. Ordinary explicit Close and Save retain their existing discard
and persistence behavior. No automatic save, discard or global draft manager is added.

ADR-050 continues to own ordinary placement, guest and action lifetimes. ADR-064 owns
installation acceptance and ADR-065 owns program connection independently of landing.
All source, native, agent, workspace and delivery grants remain separate.

## Consequences

Authors can choose a useful initial application destination without core package-specific
policy. Stale intent cannot force navigation. A preserved application draft consumes only
the existing controller's state while its surface is closed; extension and section work
continues to follow ordinary visible lifetimes.

## Rejected alternatives

- Guessing a package, filename or first view does not express author intent.
- Selecting during guest preparation can close Settings before the current Add reply.
- Saving or discarding unrelated preferences makes installation modify another workflow.
- A second navigation registry or global draft manager duplicates existing owners.
