import { describe, expect, it } from 'vitest'

import {
  parseHarnessArguments,
  serializeHarnessArguments,
} from '../src/renderer/src/settings/harness-argument-editor'

describe('harness argument editor', () => {
  it('accepts normal same-line input and the equivalent one-value-per-line form', () => {
    expect(parseHarnessArguments('--add-dir /tmp/skills')).toEqual(
      parseHarnessArguments('--add-dir\n/tmp/skills'),
    )
    expect(values(parseHarnessArguments('--add-dir /tmp/skills'))).toEqual([
      '--add-dir',
      '/tmp/skills',
    ])
  })

  it('uses quotes and escapes only to group literal argv values', () => {
    expect(
      values(
        parseHarnessArguments(
          '--model opus --label "two words" \'three words\' four\\ words',
        ),
      ),
    ).toEqual(['--model', 'opus', '--label', 'two words', 'three words', 'four words'])
  })

  it('keeps path placeholders structured after tokenization', () => {
    expect(parseHarnessArguments('--add-dir {binding:skills}')).toEqual([
      { parts: [{ kind: 'literal', value: '--add-dir' }] },
      {
        parts: [{ kind: 'path', source: 'binding', binding: 'skills' }],
      },
    ])
  })

  it('serializes structured arguments into one safe round-trippable command line', () => {
    const arguments_ = [
      { parts: [{ kind: 'literal' as const, value: '--label' }] },
      { parts: [{ kind: 'literal' as const, value: "agent's skills" }] },
      {
        parts: [
          { kind: 'literal' as const, value: '--add-dir=' },
          { kind: 'path' as const, source: 'binding' as const, binding: 'skills' },
        ],
      },
      { parts: [{ kind: 'literal' as const, value: '' }] },
    ]
    const serialized = serializeHarnessArguments(arguments_)
    expect(serialized).toBe("--label 'agent'\\''s skills' --add-dir={binding:skills} ''")
    expect(parseHarnessArguments(serialized)).toEqual(arguments_)
  })

  it('reports incomplete quoting, unknown placeholders, and shell interpolation', () => {
    expect(() => parseHarnessArguments('--label "unfinished')).toThrow(/unterminated/)
    expect(() => parseHarnessArguments('{binding:}')).toThrow(/Unknown path token/)
    expect(() => parseHarnessArguments('$HOME')).toThrow(/interpolation/)
    expect(() => parseHarnessArguments(String.fromCharCode(96) + 'whoami')).toThrow(
      /interpolation/,
    )
  })
})

function values(args: ReturnType<typeof parseHarnessArguments>): readonly string[] {
  return args.map((argument) =>
    argument.parts
      .map((part) =>
        part.kind === 'literal'
          ? part.value
          : part.source === 'binding'
            ? '{binding:' + part.binding + '}'
            : '{' + part.source + '}',
      )
      .join(''),
  )
}
