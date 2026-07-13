import { describe, expect, it } from 'vitest'

import { parseStructuredData } from '../src/renderer/src/viewer/structured-data'

describe('structured data rendering', () => {
  it('parses YAML mappings, sequences, and scalar types', () => {
    expect(
      parseStructuredData(
        'name: hvir\nenabled: true\nphases:\n  - viewer\n  - git\n',
        'yaml',
      ),
    ).toEqual({ name: 'hvir', enabled: true, phases: ['viewer', 'git'] })
  })

  it('labels multiple YAML documents explicitly', () => {
    expect(parseStructuredData('name: first\n---\nname: second\n', 'yaml')).toEqual({
      'document 1': { name: 'first' },
      'document 2': { name: 'second' },
    })
  })

  it('surfaces YAML parse errors', () => {
    expect(() => parseStructuredData('broken: [yaml', 'yaml')).toThrow()
  })
})
