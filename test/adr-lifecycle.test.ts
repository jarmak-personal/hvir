import { describe, expect, it } from 'vitest'
import { validateAdrLifecycles } from '../scripts/adr-lifecycle.mts'

function record(id: string, notice: string) {
  return [
    `ADR-${id}-example.md`,
    `# ADR-${id}: Example\n\n${notice}\n\n## Context\n\nHistorical context.\n\n## Decision\n\nHistorical decision.\n`,
  ] as const
}
function index(records: Map<string, string>) {
  return [...records]
    .map(
      ([name, source]) =>
        `### [ADR-${name.slice(4, 7)} — Example](adr/${name})\n\n${source
          .split('\n')
          .filter((line) => line.startsWith('> '))
          .join('\n')
          .replaceAll('](ADR-', '](adr/ADR-')}\n\nSummary.\n`,
    )
    .join('\n')
}
function pair(kind = 'partial', scope = 'The earlier sampling rule.') {
  return new Map([
    record(
      '001',
      `> Lifecycle: ${kind === 'full' ? 'Superseded' : 'Partially superseded'}\n> Superseded by: [ADR-002](ADR-002-example.md) | ${kind} | ${scope}`,
    ),
    record(
      '002',
      `> Lifecycle: Active\n> Supersedes: [ADR-001](ADR-001-example.md) | ${kind} | ${scope}`,
    ),
  ])
}
function replace(
  records: Map<string, string>,
  id: string,
  before: string,
  after: string,
) {
  const name = `ADR-${id}-example.md`
  records.set(name, records.get(name)!.replace(before, after))
}
function errors(records: Map<string, string>) {
  return validateAdrLifecycles(records, index(records)).join('\n')
}

describe('ADR lifecycle authority and index', () => {
  it('accepts active records and reciprocal full and partial replacement', () => {
    expect(errors(new Map([record('001', '> Lifecycle: Active')]))).toBe('')
    expect(errors(pair())).toBe('')
    expect(errors(pair('full', 'Entire decision.'))).toBe('')
  })

  it('preserves a replacement chain when its successor is itself superseded in part', () => {
    const records = pair('full', 'Entire decision.')
    replace(
      records,
      '002',
      '> Lifecycle: Active',
      '> Lifecycle: Partially superseded\n> Superseded by: [ADR-003](ADR-003-example.md) | partial | Linux platform policy.',
    )
    records.set(
      ...record(
        '003',
        '> Lifecycle: Active\n> Supersedes: [ADR-002](ADR-002-example.md) | partial | Linux platform policy.',
      ),
    )
    expect(errors(records)).toBe('')
  })

  it('accepts multiple independent partial replacements without retiring unaffected rules', () => {
    const records = pair()
    replace(
      records,
      '001',
      '\n\n## Context',
      '\n> Superseded by: [ADR-003](ADR-003-example.md) | partial | Launch defaults.\n\n## Context',
    )
    records.set(
      ...record(
        '003',
        '> Lifecycle: Active\n> Supersedes: [ADR-001](ADR-001-example.md) | partial | Launch defaults.',
      ),
    )
    expect(errors(records)).toBe('')
  })

  it('rejects missing targets and wrong target filenames', () => {
    const records = pair()
    records.delete('ADR-002-example.md')
    expect(errors(records)).toContain('missing relationship target')
    const wrong = pair()
    replace(wrong, '001', '(ADR-002-example.md)', '(ADR-002-missing.md)')
    expect(errors(wrong)).toContain('missing relationship target')
  })

  it.each([
    [
      'missing inverse',
      '> Supersedes: [ADR-001](ADR-001-example.md) | partial | The earlier sampling rule.',
      '',
    ],
    ['conflicting scope', 'The earlier sampling rule.', 'Launch defaults.'],
    [
      'conflicting kind',
      '| partial | The earlier sampling rule.',
      '| full | Entire decision.',
    ],
  ])('rejects %s', (_label, before, after) => {
    const records = pair()
    replace(records, '002', before, after)
    expect(errors(records)).toContain('nonreciprocal or conflicting relationship')
  })

  it('rejects self-links, duplicate relationships, and cycles', () => {
    const self = new Map([
      record(
        '001',
        '> Lifecycle: Partially superseded\n> Supersedes: [ADR-001](ADR-001-example.md) | partial | Sampling.\n> Superseded by: [ADR-001](ADR-001-example.md) | partial | Sampling.',
      ),
    ])
    expect(errors(self)).toContain('supersession self-link')
    const duplicate = pair()
    replace(
      duplicate,
      '002',
      '\n\n## Context',
      '\n> Supersedes: [ADR-001](ADR-001-example.md) | partial | Other rule.\n\n## Context',
    )
    expect(errors(duplicate)).toContain('duplicate or conflicting')
    const cycle = pair()
    replace(
      cycle,
      '001',
      '\n\n## Context',
      '\n> Supersedes: [ADR-002](ADR-002-example.md) | partial | Launch defaults.\n\n## Context',
    )
    replace(
      cycle,
      '002',
      '> Lifecycle: Active',
      '> Lifecycle: Partially superseded\n> Superseded by: [ADR-001](ADR-001-example.md) | partial | Launch defaults.',
    )
    expect(errors(cycle)).toContain('supersession cycle')
  })

  it.each([
    ['> Lifecycle: Partially superseded', '> Lifecycle: Active'],
    ['> Lifecycle: Partially superseded', '> Lifecycle: Superseded'],
    ['> Lifecycle: Partially superseded', '> Lifecycle: In progress'],
    ['> Lifecycle: Partially superseded', ''],
    [
      '> Lifecycle: Partially superseded',
      '> Lifecycle: Partially superseded\n> Lifecycle: Active',
    ],
    ['| partial | The earlier sampling rule.', '| partial | Entire decision.'],
    ['| partial | The earlier sampling rule.', '| full | One rule.'],
    ['| partial | The earlier sampling rule.', '| partial | '],
    ['[ADR-002](ADR-002-example.md)', '[ADR-003](ADR-002-example.md)'],
  ])('rejects invalid or contradictory metadata (%s -> %s)', (before, after) => {
    const records = pair()
    replace(records, '001', before, after)
    expect(errors(records)).not.toBe('')
  })

  it('rejects lifecycle notices inside accepted decision sections', () => {
    const records = pair()
    replace(
      records,
      '001',
      'Historical decision.',
      'Historical decision.\n\n> Lifecycle: Active',
    )
    expect(errors(records)).toContain('notices belong before Context')
  })

  it('leaves unrelated body and index quotation outside lifecycle parsing', () => {
    const records = pair()
    const mirrored = index(records).replace(
      'Summary.',
      '> A quoted feature summary.\n\nSummary.',
    )
    replace(
      records,
      '001',
      'Historical decision.',
      'Historical decision.\n\n> An accepted example.',
    )
    expect(validateAdrLifecycles(records, mirrored)).toEqual([])
  })

  it('rejects index lifecycle, scope, and relationship drift', () => {
    const records = pair()
    for (const changed of [
      index(records).replace('Lifecycle: Partially superseded', 'Lifecycle: Active'),
      index(records).replace('The earlier sampling rule.', 'Another rule.'),
      index(records).replace(/^> Superseded by:.*\n/m, ''),
      index(records).replace('### [ADR-001', '### [ADR-099'),
    ])
      expect(validateAdrLifecycles(records, changed).length).toBeGreaterThan(0)
  })

  it('rejects a replacement notice separated from the leading lifecycle block', () => {
    const records = pair()
    replace(records, '001', '\n> Superseded by:', '\n\n> Superseded by:')
    expect(errors(records)).toContain('lifecycle notices must form one leading block')
  })
})
