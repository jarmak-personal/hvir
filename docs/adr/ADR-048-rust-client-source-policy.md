# ADR-048: Rust client source coverage and dependency evidence

> Lifecycle: Active
> Supersedes: [ADR-040](ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Maintained-source language list: add Rust and Cargo dispositions; all existing budget, provenance, and TypeScript/JavaScript dependency rules remain authoritative.

## Context

The accepted extension platform includes a small `hvir-agent` client for agents on SSH
hosts. Rust allows a native client without requiring a remote Node runtime or an installed
remote service. ADR-040 requires explicit language policy before adopting maintained source
in another language. Its TypeScript/JavaScript graph cannot establish Rust dependency direction.

The client must receive the existing architecture discipline before implementation consumes
that policy. Cargo dependency metadata, generated source, and disposable build output have
different ownership and cannot become blanket source exclusions.

## Decision

The client's named maintained root is `packages/hvir-agent/`, inside ADR-040's existing
`packages/` inventory root. Recognize `.rs` throughout the existing maintained-source
inventory so Rust outside the named client root fails coverage, even inside another existing
source root or at repository root. Inside the client, count Rust build scripts, tests, examples,
and added or ignored local source. Source outside the declared roots still fails coverage.
An unsupported source suffix still fails classification. No new inventory owner, root exemption, or exceptional budget is introduced.

The existing policy data records `rustClient.root` and `rustClient.cargoOutput`. The closed
schema requires `.rs` coverage, a root inside the maintained inventory, and the exact
`<root>/target` Cargo output path. Initial adoption and later root/output changes require
separate policy-only admission before source consumption. Cumulative replay preserves that
accepted authority and rejects an independently conflicting main disposition.

Rust uses ADR-040's physical-line count, 500-line comfort target, and ordinary 1,000-line
blocking maximum. Any stricter or exceptional budget follows its existing exact classification
and separate acceptance rules. The policy checker and its fixtures retain their prior budgets.

`Cargo.toml` manifests and `Cargo.lock` lockfiles are dependency metadata, not executable
source or generated Rust. Cargo's client-local `packages/hvir-agent/target/` is disposable
build output; it contains no maintained source. Any tracked file under that output role fails
inventory, including tracked Rust or metadata. A nested `target/` directory or one elsewhere
receives no Cargo exemption. Rust outside the named client root fails coverage regardless of
that directory name. Ignored maintained source outside that exact output role still counts.
Keep maintained inputs outside disposable output and do not redirect build output onto them.

A generated Rust banner supplies no classification. Without an exact accepted generated rule,
a `.rs` file remains ordinary maintained source. Generated treatment requires ADR-040's exact
output path, generator owner, identified inputs, regeneration command, and blocking maximum.
Generated reclassification requires separately accepted policy; maintained generator source
always counts. Disposable output is not a substitute for generated classification of a
repository-owned artifact.

The client owns native argument parsing, public request framing, and client transport. It
imports no hvir main, renderer, worker, host-adapter, or other process implementation. The
platform owns public framing meaning, capabilities, authorization, targeting, and endpoint
lifecycle. Client dependency and protocol evidence must demonstrate that boundary; a green
TypeScript/JavaScript graph makes no claim about Rust imports or Cargo dependencies.

The remote-client implementation owns focused Rust compilation, tests, locked dependency
review, and public protocol evidence. Client changes and release builds run those checks,
including changes to manifests, lockfiles, and maintained build inputs. Dependency review
examines Cargo manifest/lock changes and the client module boundary rather than adding a
general Rust dependency analyzer. Normal architecture inventory and unrelated contributor
verification do not require a Rust toolchain. TypeScript/JavaScript cycle and direction
checks remain blocking and unchanged.

New source-language coverage uses ADR-040's policy-only admission before any consuming source
is added. Its exact documentation identities may include this decision, ADR-040's lifecycle
notice, the design index, and the architecture guides. Additional documentation admission
requires actual language/root adoption: ADR-040 admits only lifecycle notice changes, the
design document only the relevant decision-index entries, and the dependency guide only its
Rust boundary section. An accepted ADR-048 cannot be rewritten. Ordinary budget relaxation
retains the original budget-guide admission without these additional records. This grants no general documentation,
product-source, unrelated-tooling, or relaxed-check exception. Cumulative delivery validates
separately accepted language-policy integrations through the existing provenance owner.

## Consequences

Rust source receives predictable ordinary budgets without a second checker or a universal
Rust installation requirement. Client contributors and release builders need the focused Rust
toolchain and dependency evidence; unrelated contributors retain the existing Node workflow.

The existing graph continues to prove only its named TypeScript/JavaScript contracts. Rust
ownership and protocol evidence remain the client's responsibility. If the client acquires
another capability owner or needs an exceptional budget, realign that boundary and accept
any necessary policy separately before consumption.

## Rejected alternatives

- Adding Rust policy beside client implementation: it would consume its own authorization.
- Excluding `.rs`, all `target/` directories, or Cargo packages from inventory: maintained
  source could escape the existing ceilings.
- Treating a generated banner as provenance: it identifies neither exact inputs nor authority.
- Claiming the TypeScript/JavaScript graph proves Rust direction: it does not resolve Rust.
- Requiring Rust for every contributor check or building a general dependency analyzer:
  neither is necessary for this small native client boundary.
