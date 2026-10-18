# ADR-072: Sixteen declared extension actions

> Lifecycle: Active
> Supersedes: [ADR-050](ADR-050-extension-contributions-and-action-lifetimes.md) | partial | Eight exported action declarations per installation only.
> Supersedes: [ADR-060](ADR-060-public-skillager-advanced-exposure.md) | partial | Prohibition on increasing the eight-action declaration ceiling only.

## Context

An extension may expose distinct operations with different effects and caller permissions.
Eight exported declarations can force unrelated tasks behind one misleading action name even
when the package needs no additional active runtime or concurrent work. Declaration capacity
and execution capacity protect different resources.

## Decision

Allow at most sixteen declared semantic actions per installation through the existing public
manifest contract and package validator. Each action retains its own identity, input schema,
agent-access declaration and delete/replace effects. Declarations do not require a primary
button for every action; views may expose tasks contextually.

The complete manifest remains bounded to 32 KiB, including every action and schema. Progressive
agent discovery continues through the existing bounded metadata pages and focused declaration
command. An individually valid declaration does not exempt the containing manifest or transport
response from its complete byte bound. Refuse oversized content without truncating actions,
schemas or effects.

All other limits and authority rules remain unchanged: eight views and eight terminal-rail
items per installation, four concurrent actions per installation and sixteen globally, 8 KiB
action input/result and connector argv, 16 KiB bridge messages, existing request/rate bounds,
and the existing default and maximum deadlines. Named actions use the current guest, caller,
context, grant, revocation and finite invocation owners. More declarations neither allocate
another guest nor confer permission to execute them.

This replaces only the eight-action declaration ceilings in ADR-050 and ADR-060. Skillager's
advanced whole-plan semantics, preservation, reconciliation and other action relationships
remain authoritative; a new domain operation still needs its own aligned public contract.

## Consequences

Extensions can give distinct tasks clear names and effects without a catch-all command action.
Large declarations may reach the manifest byte bound before the action count, and discovery
may require another existing page. The finite declaration count continues to bound inspection
and metadata work independently from execution capacity.

## Rejected alternatives

- Overloading an unrelated action hides distinct inputs, effects and caller permissions.
- An action per implementation-level CLI verb would expose internal mechanics rather than
  coherent user tasks.
- Unbounded declarations or larger payload and concurrency limits would relax unrelated
  resource contracts without a demonstrated need.
