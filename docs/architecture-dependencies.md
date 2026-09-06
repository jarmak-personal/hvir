# Architecture dependencies

ADR-014 and ADR-040 own dependency direction and runtime-cycle policy. The existing
`architecture:report` and `architecture:check` commands report the module graph beside source
budgets; normal `npm run verify` and CI execute the enforcing command. Reporting is provisional
about budget authorization. An enforcing run fails on runtime cycles (including self-loops),
forbidden directions, unresolved internal modules, absent required inputs, or malformed rules.

`architecture-inventory.mts` supplies the same complete maintained-source inventory used by the
budget checker: `src`, `test`, `scripts`, `packages`, `build`, `.github`, `.githooks`, `.agents`,
`.claude`, and repository-root source files. The graph includes TypeScript, JavaScript, and
declarations in every supported suffix, including added local source and generated maintained
modules. Repository-owned symlink aliases resolve to their canonical target once. The inventory
owner retains its explicit installed-dependency, Git-internal, and disposable-output exclusions;
graph code does not create a second source-root policy.

## Resolution and emission

`architecture-module-resolution.mts` uses the installed TypeScript compiler's parser, config
loader, resolver, and emitter. Renderer source and renderer test files use `tsconfig.web.json`;
files selected by the node config use `tsconfig.node.json`; remaining maintained tooling/root
modules use `tsconfig.base.json`. These required inputs include their inherited configuration.
Each effective options object has its own resolution cache. Resolution honors configured aliases
and canonical repository paths; arbitrary escaped local sources are not installed dependencies.

The graph records static imports, re-exports, inline import types, import-equals declarations,
literal dynamic imports, and literal `require` calls, including file-local bindings and inline
calls to the named Node `createRequire` import. Runtime edges are determined from emitted
JavaScript. Explicit `import type` and declaration-file references remain erased; mixed imports
and inline-only `import { type T }` follow the configured emission behavior. With the current
`verbatimModuleSyntax`, an inline-only import can emit `import {}` and retain module side effects.
An existing runtime `.mjs` implementation remains a runtime target even when TypeScript initially
resolves its `.d.mts` companion; the declaration remains a visible type target too. A required
local runtime implementation cannot be replaced by declaration-only evidence.

`architecture-module-graph.mts` reports deterministic module paths, source locations, forms,
runtime/type-only edge kinds, and both static and runtime strongly connected components. The
JSON report includes every edge and loading disposition; the compact text report includes each
component's internal edges and all non-external loading. A static component that requires erased
edges is an ownership-review signal, not an automatic cycle failure. New components require the
same explicit ownership assessment in their governing issue/PR as existing ones.

## Explicit loading limits

Installed packages and Node builtins are external leaves. Existing CSS, JSON, image/font, HTML,
text, and WASM files are asset-loading rows, not invented TypeScript/JavaScript nodes. Missing
assets and directories masquerading as modules fail resolution. Maintained generated JS/TS is
still graph source, irrespective of its separate generated size classification.

The exact native output `packages/rename-noreplace/build/Release/rename_noreplace.node`, loaded by
that package's `index.js`, is an explicit build-artifact role. Its maintained `binding.gyp` and
`rename_noreplace.c` are required inputs; the disposable native binary itself need not exist
before a build. This role does not exempt another `.node` import.

Literal `Worker`/`SharedWorker` entrypoints, including `new URL(..., import.meta.url)`, are
resolved process-loading rows subject to direction checks. They do not imply same-module
evaluation and are outside that cycle proof. Nonliteral import/require/worker discovery and
`import.meta.glob`/`require.resolve` are visible by owner, form, and location. Static analysis
does not prove their runtime topology; the owning process/resource and authority seams continue
to govern them. A report of zero runtime module cycles is not a claim of universal acyclicity.

The contributor wrappers' Vite `ssrLoadModule` calls identify maintained entrypoints but execute
through a separate module runner, so they remain visible discovery rows outside native-module
cycle proof. Electron `utilityProcess.fork` likewise exposes the process-loading boundary; its
computed entry path is not inferred from runtime values. These named loading forms do not imply
that arbitrary library APIs or reflective alias chains can be statically resolved.

## One direction-policy owner

`eslint.config.mjs` and its existing smoke rule retain the named direction policy.
`architecture-module-directions.mts` adapts graph edges to those effective ESLint rules rather
than maintaining another ban table. It checks original and canonically resolved relative
specifiers, preserving imported-name restrictions and actual dynamic/import-type/require forms.
Maintained JS/declaration variants of application and Project adapter owners use their existing
TS owner rules. Type erasure, aliases, directory indexes, or a JS extension cannot reverse a
protected direction. The exact main bootstrap's dynamic smoke import remains distinguished from
a static import; only the smoke dispatcher may depend on the smoke root.

The module adapter does not duplicate non-import authority checks such as `spawnPty` member
access. Their existing ESLint and seam checks remain part of normal verification. Rule/probe
configuration errors fail visibly. Invalid graph examples live only in temporary repositories
created by focused tests, so acceptance fixtures cannot become source-inventory exemptions.

## Capability contracts and permitted relationships

Diagnostic evidence owns its closed recent/durable records and writer port. IPC authority owns
the registered-project and renderer-resource port it consumes; the feature dependency aggregate
composes that port. Viewer state belongs below the reducer and read/path policies. Tree action
requests carry the shared target and focus context below effect hooks. Document-review workspace
state and binding sit below interaction/delivery effects. Canonical Project membership records
belong below both the Project client and field adapter. Compatibility type re-exports do not
make concrete consumers the contract owners.

The reciprocal erased relationship between `src/shared/harness-profile.ts` and
`src/shared/harness-provider.ts` is permitted: a serializable profile names its provider, and a
serializable profile probe names the profile it qualified. Both are shared capability contracts
with no concrete provider, Electron, or host behavior. Their branded identifiers retain the
capability vocabulary and neither module gains runtime authority over the other. Reconsider
this relationship if a reference begins importing runtime behavior or either contract acquires
concrete implementation dependencies. This rationale does not authorize another component or
override any forbidden direction.
