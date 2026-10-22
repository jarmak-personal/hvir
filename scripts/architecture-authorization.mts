import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  POLICY_PATH,
  assertCoverageNotReduced,
  disposableDirectory,
  evaluateInventory,
  isRelaxation,
  inScope,
  readAcceptedPolicy,
  relaxedPaths,
  ruleFor,
  validatePolicy,
  type ArchitecturePolicy,
  type ArchitectureRule,
  type ComparisonCounts,
  type SourceInventory,
} from './architecture-policy.mts'
import {
  createArchitectureInventory,
  git,
  requireAncestor,
  validateGeneratedOwnership,
  type ArchitectureInventory,
} from './architecture-inventory.mts'
import { policyOnlyPath, admitArchitectureWiring } from './architecture-wiring.mts'
export interface ArchitectureContext {
  kind: 'ordinary' | 'epic-child' | 'cumulative'
  target: string
  epic: string | null
  base: string
  head: string
  tested?: string
}
export interface ArchitectureIntegration {
  epic: string
  pullRequest: number
  base: string
  head: string
  merge: string
}

export function changedPaths(
  root: string,
  base: string,
  head: string | null = null,
): string[] {
  const changed = git(root, [
    'diff',
    '--name-only',
    '-z',
    base,
    ...(head ? [head] : []),
    '--',
  ])
    .split('\0')
    .filter(Boolean)
  if (!head)
    changed.push(
      ...git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    )
  return [...new Set(changed)].sort()
}

export function admitPolicyProposal({
  root,
  base,
  head = null,
  before,
  after,
  inventory,
  source = createArchitectureInventory(root),
}: {
  root: string
  base: string
  head?: string | null
  before: ArchitecturePolicy
  after: ArchitecturePolicy
  inventory: SourceInventory
  source?: ArchitectureInventory
}) {
  const changes = changedPaths(root, base, head)
  const adoptsCoverage = changesSourceCoverage(before, after)
  if (!changes.length || changes.some((path) => !policyOnlyPath(path, adoptsCoverage))) {
    throw new Error(
      'Unaccepted policy relaxation: a separate policy-only PR with unchanged consuming source is required',
    )
  }
  assertCoverageNotReduced(before, after)
  const read = (path: string) =>
    head
      ? source.blob(head, path)
      : (() => {
          try {
            return readFileSync(join(root, path))
          } catch {
            return null
          }
        })()
  for (const path of changes)
    admitArchitectureWiring(path, source.blob(base, path), read(path), adoptsCoverage)
  for (const path of relaxedPaths(
    before,
    after,
    inventory.keys(),
    source.comparisonCounts(inventory, [base]),
  )) {
    const oldBytes = source.blob(base, path)
    const newBytes = read(path)
    if (oldBytes === null && newBytes === null && ruleFor(after, path).kind === 'durable')
      continue
    if (oldBytes === null || newBytes === null || !oldBytes.equals(newBytes)) {
      throw new Error(`Policy proposal changes its newly authorized source: ${path}`)
    }
  }
  // A changed Cargo output role must not hide current source from proposal inspection.
  if (before.rustClient && !isDeepStrictEqual(before.rustClient, after.rustClient))
    source.collectInventory(before, head)
  for (const [path, bytes] of inventory) {
    const newlyCovered =
      !inScope(path, before) ||
      (disposableDirectory(path, before) && !disposableDirectory(path, after)) ||
      (!before.extensions.includes(extname(path)) &&
        after.extensions.includes(extname(path)))
    if (newlyCovered && !source.blob(base, path)?.equals(bytes))
      throw new Error(`Policy proposal changes its newly authorized source: ${path}`)
  }
  const changedSource = new Map([...inventory].filter(([path]) => changes.includes(path)))
  const priorRows = evaluateInventory(
    before,
    changedSource,
    source.comparisonCounts(changedSource, [base]),
  )
  if (priorRows.some((row) => row.status === 'over'))
    throw new Error(
      'Checker and fixtures must obey prior budgets or the ordinary default',
    )
  validateGeneratedOwnership(after, read)
  return { kind: 'policy-proposal', paths: changes }
}

function sameRule(a: ArchitectureRule, b: ArchitectureRule) {
  return isDeepStrictEqual(a, b)
}

export function replayPolicyDelta(
  current: ArchitecturePolicy,
  before: ArchitecturePolicy,
  after: ArchitecturePolicy,
): ArchitecturePolicy {
  assertCoverageNotReduced(before, after)
  if (
    before.defaultMaximum !== after.defaultMaximum &&
    current.defaultMaximum !== before.defaultMaximum &&
    current.defaultMaximum !== after.defaultMaximum
  ) {
    throw new Error('Accepted epic default conflicts with current main policy')
  }
  const next = globalThis.structuredClone(current)
  if (!isDeepStrictEqual(before.rustClient, after.rustClient)) {
    if (
      !isDeepStrictEqual(current.rustClient, before.rustClient) &&
      !isDeepStrictEqual(current.rustClient, after.rustClient)
    )
      throw new Error('Accepted Rust client authority conflicts with current main policy')
    next.rustClient = after.rustClient
  }
  if (before.defaultMaximum !== after.defaultMaximum)
    next.defaultMaximum = after.defaultMaximum
  next.roots = [...new Set([...current.roots, ...after.roots])]
  next.extensions = [...new Set([...current.extensions, ...after.extensions])]
  const paths = new Set(
    [...before.budgets, ...before.generated, ...after.budgets, ...after.generated].map(
      (e) => e.path,
    ),
  )
  for (const path of paths) {
    const prior = ruleFor(before, path),
      proposed = ruleFor(after, path),
      existing = ruleFor(current, path)
    if (sameRule(prior, proposed)) continue
    // Preserve an independently stricter main rule before classifying the older
    // epic delta. The final candidate must adopt main's rule to pass admission.
    if (
      !sameRule(existing, prior) &&
      !sameRule(existing, proposed) &&
      !isRelaxation(proposed, existing)
    )
      continue
    if (
      !sameRule(existing, prior) &&
      !sameRule(existing, proposed) &&
      isRelaxation(existing, proposed)
    ) {
      throw new Error(
        `Accepted epic rule conflicts with independently changed main policy: ${path}`,
      )
    }
    next.budgets = next.budgets.filter((e) => e.path !== path)
    next.generated = next.generated.filter((e) => e.path !== path)
    if (proposed.kind === 'generated') {
      const { kind: _kind, ...entry } = proposed
      next.generated.push(entry)
    } else if (proposed.kind !== 'ordinary') next.budgets.push(proposed)
  }
  return next
}

function changesSourceCoverage(
  before: ArchitecturePolicy,
  after: ArchitecturePolicy,
): boolean {
  return (
    after.roots.some((root) => !before.roots.includes(root)) ||
    after.extensions.some((extension) => !before.extensions.includes(extension)) ||
    !isDeepStrictEqual(before.rustClient, after.rustClient)
  )
}

// New language/root authority must precede its consuming source, just like a budget.
function needsPolicyProposal(
  before: ArchitecturePolicy,
  after: ArchitecturePolicy,
  inventory: SourceInventory,
  counts: ComparisonCounts,
): boolean {
  return (
    changesSourceCoverage(before, after) ||
    after.defaultMaximum > before.defaultMaximum ||
    relaxedPaths(before, after, inventory.keys(), counts).length > 0
  )
}

export async function authorizeCandidate({
  root,
  context,
  loadIntegration,
}: {
  root: string
  context: ArchitectureContext
  loadIntegration: (merge: string, epic: string) => Promise<ArchitectureIntegration>
}) {
  const source = createArchitectureInventory(root)
  const { base, head, epic } = context
  requireAncestor(root, base, head)
  let accepted = readAcceptedPolicy(source.blob(base, POLICY_PATH))
  const candidate = validatePolicy(
    JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8')),
  )
  const inventory = source.collectInventory(candidate)
  const revisions = [base]
  const integrations = []
  if (context.kind === 'cumulative') {
    if (!epic) throw new Error('Missing cumulative epic identity')
    const commits = git(root, [
      'rev-list',
      '--first-parent',
      '--reverse',
      `${base}..${head}`,
    ])
      .split('\n')
      .filter(Boolean)
    for (const merge of commits) {
      const parents = git(root, ['show', '-s', '--format=%P', merge]).split(' ')
      if (parents.length < 2) {
        if (
          parents[0] &&
          !source
            .blob(parents[0], POLICY_PATH)
            ?.equals(source.blob(merge, POLICY_PATH) ?? new Uint8Array())
        ) {
          throw new Error(`Policy commit lacks separately accepted PR evidence: ${merge}`)
        }
        continue
      }
      // Integrating current main is already represented by B; it supplies no epic authorization.
      try {
        requireAncestor(root, parents[1]!, base)
        continue
      } catch {
        /* child integration */
      }
      const evidence = await loadIntegration(merge, epic)
      if (
        evidence.merge !== merge ||
        evidence.epic !== epic ||
        evidence.base !== parents[0] ||
        evidence.head !== parents[1]
      ) {
        throw new Error(`Mismatched accepted integration evidence: ${merge}`)
      }
      requireAncestor(root, evidence.base, evidence.head)
      requireAncestor(root, merge, head)
      if (
        git(root, ['rev-parse', `${merge}^{tree}`]) !==
        git(root, ['rev-parse', `${evidence.head}^{tree}`])
      )
        throw new Error('Accepted integration changed the tested tree')
      const before = readAcceptedPolicy(source.blob(evidence.base, POLICY_PATH))
      const afterBytes = source.blob(evidence.head, POLICY_PATH)
      if (!afterBytes) throw new Error('Missing integrated policy')
      if (!source.blob(evidence.base, POLICY_PATH)?.equals(afterBytes)) {
        const after = validatePolicy(JSON.parse(afterBytes.toString()))
        const integratedInventory = source.collectInventory(after, evidence.head)
        if (
          needsPolicyProposal(
            before,
            after,
            integratedInventory,
            source.comparisonCounts(integratedInventory, [evidence.base]),
          )
        ) {
          admitPolicyProposal({
            root,
            base: evidence.base,
            head: evidence.head,
            before,
            after,
            inventory: integratedInventory,
            source,
          })
        }
        accepted = replayPolicyDelta(accepted, before, after)
      }
      revisions.push(merge)
      integrations.push({
        pullRequest: evidence.pullRequest,
        base: evidence.base,
        head: evidence.head,
        merge,
      })
    }
  }
  assertCoverageNotReduced(accepted, candidate)
  const counts = source.acceptedRatchetCounts(
    accepted,
    base,
    source.comparisonCounts(inventory, revisions),
  )
  let admission: { kind: string; paths?: string[] } = { kind: 'accepted-policy' }
  if (needsPolicyProposal(accepted, candidate, inventory, counts)) {
    if (context.kind === 'cumulative')
      throw new Error(
        'Cumulative policy conflicts with independently changed main policy or lacks separately accepted authorization',
      )
    admission = admitPolicyProposal({
      root,
      base,
      before: accepted,
      after: candidate,
      inventory,
      source,
    })
  }
  validateGeneratedOwnership(candidate, (path) => {
    try {
      return readFileSync(join(root, path))
    } catch {
      return null
    }
  })
  const rows = evaluateInventory(candidate, inventory, counts)
  return {
    // Internal current-tree inputs for graph/removal checks; never report source bytes.
    policy: candidate,
    inventory,
    version: 2,
    mode: 'enforce',
    context,
    admission,
    integrations,
    rows,
    violations: rows.filter((row) => row.status === 'over'),
  }
}
