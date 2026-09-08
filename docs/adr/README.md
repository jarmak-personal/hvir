# Architecture decision records

Accepted architecture decisions live in this directory. The canonical record list is
the [decision index in `docs/design.md`](../design.md#4-key-decisions); that index also
preserves the anchors used by older links into the former embedded records.

Each ADR describes one durable decision through context, decision, consequences, and
rejected alternatives. ADRs do not track implementation, acceptance, test runs, or
delivery status. That work belongs in GitHub issues, commits, and pull requests.

Use [`TEMPLATE.md`](TEMPLATE.md) for a new record. Name accepted records
`ADR-NNN-short-kebab-title.md`. If a decision changes, add a new ADR and link the two;
do not rewrite an accepted record to imply a different history.

Start with the index's [read-first constraints](../design.md#read-first-constraints), then read
the relevant feature decisions. Reading priority does not determine a record's lifecycle.

## Lifecycle notices

Every record has one readable notice before `## Context`: `> Lifecycle: Active`,
`> Lifecycle: Partially superseded`, or `> Lifecycle: Superseded`. These describe accepted
decision authority, never implementation or delivery status. Unaffected rules in a partially
superseded record remain authoritative. A fully superseded record is accepted history.

Add one relationship line per pair and direction, using this exact Markdown shape:

```text
> Supersedes: [ADR-011](ADR-011-npm-native-payload-distribution.md) | full | Entire decision.
> Superseded by: [ADR-022](ADR-022-platform-native-github-release-installation.md) | full | Entire decision.
```

`full` always uses `Entire decision.`; `partial` names the affected rule. On the other record,
add the inverse direction with identical kind and scope. The target must be a direct local ADR
link. Preserve previous edges when a successor is itself superseded: readers need the chain and
its scopes. Do not infer new relationships from implementation drift or rewrite accepted
Context, Decision, Consequences, or Rejected alternatives sections. Resolve ambiguous scope in
the governing issue before recording it.

The lifecycle is `Superseded` if any incoming relationship replaces the entire decision,
`Partially superseded` if incoming relationships replace only specific rules, and `Active` if
there are no incoming relationships. Outgoing relationships do not retire the successor.
Mirror the notice and every relationship in the existing design-index entry, adding `adr/` to
link paths. Keep the entry heading unchanged so old anchors survive. `npm run check-adrs`
validates this representation, reciprocal scopes, acyclic chains, and record/index agreement.
