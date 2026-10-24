import { describe, expect, it } from 'vitest'

import {
  parseJsonLines,
  parseStructuredData,
} from '../src/renderer/src/viewer/structured-data'

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

describe('JSONL records', () => {
  it('preserves record order, nested values and every JSON scalar with CRLF', () => {
    const values = [{ nested: [1, { ok: true }] }, [false, null], 'a\nb', 0, false, null]
    expect(
      parseJsonLines(values.map((value) => JSON.stringify(value)).join('\r\n') + '\r\n'),
    ).toEqual(values.map((value, index) => ({ line: index + 1, value })))
  })

  it('identifies invalid and blank records without losing later source lines', () => {
    expect(parseJsonLines('true\n{invalid}\n\nnull\n')).toEqual([
      { line: 1, value: true },
      { line: 2, error: 'Invalid JSON record' },
      { line: 3, error: 'Invalid JSON record' },
      { line: 4, value: null },
    ])
  })

  it('distinguishes empty input, a blank record, and an unterminated final record', () => {
    expect(parseJsonLines('')).toEqual([])
    expect(parseJsonLines('\n')).toEqual([{ line: 1, error: 'Invalid JSON record' }])
    expect(parseJsonLines('42')).toEqual([{ line: 1, value: 42 }])
  })
})
