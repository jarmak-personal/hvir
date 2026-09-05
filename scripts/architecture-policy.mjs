// Architecture budgets are data. No policy blob is executed, including historical blobs.
export const POLICY_PATH = 'scripts/architecture-hotspots.json'
export const SOURCE_ROOTS = [
  'src',
  'test',
  'scripts',
  'packages',
  'build',
  '.github',
  '.githooks',
  '.agents',
  '.claude',
]
export const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.sh',
  '.bash',
  '.zsh',
  '.c',
  '.h',
]
export const DISPOSABLE_ROLES = {
  node_modules: 'installed dependencies',
  '.git': 'Git internals',
  out: 'disposable build output',
  dist: 'disposable distribution output',
  coverage: 'disposable test coverage',
}

export function physicalLines(bytes) {
  if (!bytes.length) return 0
  let count = 0
  for (const byte of bytes) if (byte === 10) count++
  return count + (bytes[bytes.length - 1] === 10 ? 0 : 1)
}

function closed(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`Malformed ${label}: unexpected fields`)
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`)
}
function maximum(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Malformed integer maximum')
}
export function repositoryPath(value) {
  text(value, 'repository path')
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((p) => !p || p === '..' || p === '.') ||
    /[*?[\]]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  ) {
    throw new Error(`Invalid exact repository path: ${value}`)
  }
  return value
}
function uniqueStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((v) => typeof v !== 'string') ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`Malformed ${label}`)
  }
}

export function validatePolicy(policy) {
  closed(
    policy,
    [
      'version',
      'comfortLines',
      'defaultMaximum',
      'roots',
      'extensions',
      'budgets',
      'generated',
    ],
    'policy',
  )
  if (policy.version !== 2 || policy.comfortLines !== 500)
    throw new Error('Unsupported architecture policy version or comfort target')
  maximum(policy.defaultMaximum)
  uniqueStrings(policy.roots, 'roots')
  uniqueStrings(policy.extensions, 'extensions')
  if (
    SOURCE_ROOTS.some((root) => !policy.roots.includes(root)) ||
    SOURCE_EXTENSIONS.some((ext) => !policy.extensions.includes(ext))
  ) {
    throw new Error('Required maintained source roots/extensions cannot be excluded')
  }
  policy.roots.forEach(repositoryPath)
  if (policy.extensions.some((ext) => !/^\.[a-z]+$/.test(ext)))
    throw new Error('Malformed source extension')
  if (!Array.isArray(policy.budgets) || !Array.isArray(policy.generated))
    throw new Error('Missing classifications')
  const paths = new Set()
  for (const entry of [...policy.budgets, ...policy.generated]) {
    repositoryPath(entry.path)
    if (paths.has(entry.path))
      throw new Error(`Conflicting classification: ${entry.path}`)
    paths.add(entry.path)
    maximum(entry.maxLines)
    for (const key of ['owner', 'rationale', 'reconsiderWhen']) text(entry[key], key)
    if (policy.budgets.includes(entry)) {
      closed(
        entry,
        [
          'path',
          'kind',
          'maxLines',
          'owner',
          'rationale',
          'reconsiderWhen',
          'removalIssue',
        ],
        'budget',
      )
      if (!['stricter', 'transitional', 'durable'].includes(entry.kind))
        throw new Error(`Unknown budget kind: ${entry.path}`)
      if ((entry.kind === 'stricter') !== entry.maxLines <= policy.defaultMaximum)
        throw new Error(`Inconsistent budget maximum: ${entry.path}`)
      if (entry.kind === 'transitional') {
        if (!/^#[1-9]\d*$/.test(entry.removalIssue))
          throw new Error(`Missing current removal issue: ${entry.path}`)
      } else if (entry.removalIssue !== undefined)
        throw new Error(`Unexpected removal issue: ${entry.path}`)
    } else {
      closed(
        entry,
        [
          'path',
          'maxLines',
          'owner',
          'rationale',
          'reconsiderWhen',
          'generator',
          'inputs',
          'command',
        ],
        'generated declaration',
      )
      repositoryPath(entry.generator)
      if (entry.generator === entry.path)
        throw new Error('Generated output cannot own its generator')
      text(entry.command, 'regeneration command')
      if (!Array.isArray(entry.inputs) || !entry.inputs.length)
        throw new Error('Missing generated inputs')
      for (const input of entry.inputs) {
        closed(input, ['path', 'sha256'], 'generated input')
        repositoryPath(input.path)
        if (!/^[a-f0-9]{64}$/.test(input.sha256))
          throw new Error('Missing generated input identity')
      }
    }
  }
  if (
    policy.generated.some((entry) =>
      policy.generated.some((other) => other.path === entry.generator),
    )
  )
    throw new Error('Generator source must be maintained')
  return policy
}

export function ruleFor(policy, path) {
  const generated = policy.generated.find((entry) => entry.path === path)
  if (generated) return { ...generated, kind: 'generated' }
  return (
    policy.budgets.find((entry) => entry.path === path) ?? {
      kind: 'ordinary',
      maxLines: policy.defaultMaximum,
    }
  )
}

export function isRelaxation(before, after, priorCounts = []) {
  const priorLimit = ['stricter', 'transitional'].includes(before.kind)
    ? Math.min(before.maxLines, ...priorCounts)
    : before.maxLines
  if (after.maxLines > before.maxLines) return true
  if (
    ['stricter', 'transitional'].includes(before.kind) &&
    before.kind !== after.kind &&
    after.maxLines > priorLimit
  )
    return true
  if (
    after.kind === 'generated' &&
    (before.kind !== 'generated' ||
      before.generator !== after.generator ||
      before.command !== after.command ||
      before.owner !== after.owner ||
      JSON.stringify(before.inputs.map((e) => e.path)) !==
        JSON.stringify(after.inputs.map((e) => e.path)))
  )
    return true
  if (after.kind === 'durable' && before.kind !== 'durable') return true
  return false
}

export function relaxedPaths(before, after, paths, counts = new Map()) {
  return [
    ...new Set([
      ...paths,
      ...before.budgets.map((e) => e.path),
      ...after.budgets.map((e) => e.path),
      ...before.generated.map((e) => e.path),
      ...after.generated.map((e) => e.path),
    ]),
  ].filter((path) =>
    isRelaxation(ruleFor(before, path), ruleFor(after, path), counts.get(path)),
  )
}

export function assertCoverageNotReduced(before, after) {
  if (
    before.roots.some((root) => !after.roots.includes(root)) ||
    before.extensions.some((ext) => !after.extensions.includes(ext))
  ) {
    throw new Error('Unauthorized reduction of source coverage')
  }
}

// One bounded migration from the retired schema; no ancestry-based file immunity survives.
export function readAcceptedPolicy(bytes) {
  const raw = JSON.parse(bytes.toString())
  if (raw.version !== 1) return validatePolicy(raw)
  if (
    !Array.isArray(raw.legacyHotspots) ||
    raw.limits?.newProductionModule !== 500 ||
    raw.limits?.testModule !== 1200 ||
    raw.limits?.generatedModule !== 5000
  ) {
    throw new Error('Unrecognized pre-bootstrap policy')
  }
  return {
    version: 2,
    comfortLines: 500,
    defaultMaximum: 1000,
    roots: SOURCE_ROOTS,
    extensions: SOURCE_EXTENSIONS,
    budgets: raw.legacyHotspots
      .filter((e) => e.maxLines <= 1000)
      .map((e) => ({ ...e, kind: 'stricter' })),
    generated: [],
  }
}

export function evaluateInventory(policy, inventory, comparisonCounts = new Map()) {
  return [...inventory]
    .map(([path, bytes]) => {
      const rule = ruleFor(policy, path)
      const lines = physicalLines(bytes)
      const counts = comparisonCounts.get(path) ?? []
      if (rule.kind === 'transitional' && !counts.length)
        throw new Error(`Missing comparison-base source for transitional budget: ${path}`)
      const effectiveLimit = ['stricter', 'transitional'].includes(rule.kind)
        ? Math.min(rule.maxLines, ...counts)
        : rule.maxLines
      const category =
        rule.kind === 'generated'
          ? 'generated'
          : path.startsWith('src/main/smoke/')
            ? 'smoke'
            : path.startsWith('test/') || /\.(test|spec)\./.test(path)
              ? 'test'
              : path.startsWith('src/')
                ? 'production'
                : 'tooling'
      return {
        path,
        category,
        lines,
        governingRule: rule.kind,
        declaredLimit: rule.maxLines,
        effectiveLimit,
        aboveComfort: lines > policy.comfortLines,
        status: lines > effectiveLimit ? 'over' : 'ok',
        ...(rule.kind === 'ordinary' ? {} : { exception: rule }),
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
