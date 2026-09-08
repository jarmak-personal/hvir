type Relationship = {
  direction: 'Supersedes' | 'Superseded by'
  target: string
  file: string
  kind: 'full' | 'partial'
  scope: string
}
type Lifecycle = { state: string; relationships: Relationship[] }

// The readable Markdown preamble is the authority; the design index mirrors it.
function parseLifecycle(
  source: string,
  label: string,
  prefix: string,
  errors: string[],
): Lifecycle {
  const preamble = source.trimStart().split('\n')
  const boundary = preamble.findIndex((line) => !line.startsWith('> '))
  const lines = boundary < 0 ? preamble : preamble.slice(0, boundary)
  const remainder = boundary < 0 ? [] : preamble.slice(boundary)
  if (remainder.some((line) => /^> (?:Lifecycle|Supersedes|Superseded by):/.test(line))) {
    errors.push(`${label}: lifecycle notices must form one leading block`)
  }
  const states = lines.filter((line) => line.startsWith('> Lifecycle:'))
  const state = states[0]?.slice('> Lifecycle: '.length) ?? ''
  if (
    states.length !== 1 ||
    !['Active', 'Partially superseded', 'Superseded'].includes(state)
  ) {
    errors.push(`${label}: expected one valid Lifecycle notice`)
  }
  const relationships: Relationship[] = []
  for (const line of lines.filter((line) => !line.startsWith('> Lifecycle:'))) {
    const match =
      /^> (Supersedes|Superseded by): \[ADR-(\d{3})\]\(([^)]+)\) \| (full|partial) \| (\S.*)$/.exec(
        line,
      )
    if (!match) {
      errors.push(`${label}: malformed lifecycle relationship`)
      continue
    }
    const [, direction = '', target = '', href = '', kind = '', scope = ''] = match
    const file = href.slice(prefix.length)
    if (
      !href.startsWith(prefix) ||
      !file.startsWith(`ADR-${target}-`) ||
      !/^ADR-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)
    ) {
      errors.push(`${label}: relationship must link directly to its named ADR`)
    }
    if (
      (kind === 'full' && scope !== 'Entire decision.') ||
      (kind === 'partial' && scope === 'Entire decision.')
    ) {
      errors.push(`${label}: replacement scope conflicts with ${kind} relationship`)
    }
    relationships.push({
      direction: direction as Relationship['direction'],
      target,
      file: href.slice(prefix.length),
      kind: kind as Relationship['kind'],
      scope,
    })
  }
  const incoming = relationships.filter((edge) => edge.direction === 'Superseded by')
  const expected = incoming.some((edge) => edge.kind === 'full')
    ? 'Superseded'
    : incoming.length
      ? 'Partially superseded'
      : 'Active'
  if (state !== expected)
    errors.push(
      `${label}: Lifecycle must be ${expected} for its replacement relationships`,
    )
  const keys = relationships.map((edge) => `${edge.direction}:${edge.target}`)
  if (new Set(keys).size !== keys.length)
    errors.push(`${label}: duplicate or conflicting relationships`)
  return { state, relationships }
}

export function validateAdrLifecycles(
  records: Map<string, string>,
  index: string,
): string[] {
  const errors: string[] = []
  const lifecycles = new Map<string, Lifecycle>()
  const names = new Map<string, string>()
  for (const [name, source] of records) {
    const id = name.slice(4, 7)
    names.set(id, name)
    const context = source.indexOf('\n## Context\n')
    const preamble = source.slice(source.indexOf('\n') + 1, context)
    lifecycles.set(id, parseLifecycle(preamble, name, '', errors))
    if (/^> (?:Lifecycle|Supersedes|Superseded by):/m.test(source.slice(context))) {
      errors.push(`${name}: lifecycle notices belong before Context`)
    }
  }
  const entries = [
    ...index.matchAll(
      /^### \[ADR-(\d{3}) — [^\]]+\]\(adr\/[^)]+\)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm,
    ),
  ]
  for (const [id, lifecycle] of lifecycles) {
    const entry = entries.find((match) => match[1] === id)
    if (!entry) {
      errors.push(`ADR-${id}: missing lifecycle index entry`)
      continue
    }
    const mirrored = parseLifecycle(entry[2] ?? '', `index ADR-${id}`, 'adr/', errors)
    const normalized = (value: Lifecycle) =>
      JSON.stringify({
        state: value.state,
        relationships: value.relationships.map((edge) => JSON.stringify(edge)).sort(),
      })
    if (normalized(lifecycle) !== normalized(mirrored))
      errors.push(`ADR-${id}: inconsistent record/index lifecycle`)
    for (const edge of lifecycle.relationships) {
      if (edge.target === id) errors.push(`ADR-${id}: supersession self-link`)
      if (names.get(edge.target) !== edge.file) {
        errors.push(`ADR-${id}: missing relationship target ${edge.file}`)
        continue
      }
      const inverse = edge.direction === 'Supersedes' ? 'Superseded by' : 'Supersedes'
      const reciprocal = lifecycles
        .get(edge.target)
        ?.relationships.find(
          (other) => other.direction === inverse && other.target === id,
        )
      if (
        !reciprocal ||
        reciprocal.kind !== edge.kind ||
        reciprocal.scope !== edge.scope
      ) {
        errors.push(
          `ADR-${id}: nonreciprocal or conflicting relationship with ADR-${edge.target}`,
        )
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string) {
    if (visiting.has(id)) {
      errors.push(`ADR-${id}: supersession cycle`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const edge of lifecycles.get(id)?.relationships ?? []) {
      if (edge.direction === 'Supersedes') visit(edge.target)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of lifecycles.keys()) visit(id)
  return errors
}
