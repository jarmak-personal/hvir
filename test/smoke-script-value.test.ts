import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { smokeScriptValue } from '../src/main/smoke/script-value'

describe('smoke script values', () => {
  it.each([
    ['quotes', `single' and double"`],
    ['backslashes', String.raw`C:\fixture\"quoted"\file`],
    ['control characters', '\0\b\f\n\r\t'],
    ['Unicode', '保存-𐐨-\u2028-\u2029'],
    ['script tags', '</script><script>globalThis.injected=true</script>'],
    ['code-looking data', `');globalThis.injected=true;//`],
  ])('preserves %s as data during evaluation', (_label, value) => {
    const expression = smokeScriptValue(value)
    const context = { injected: false }
    expect(runInNewContext(`(() => ${expression})()`, context)).toBe(value)
    expect(context.injected).toBe(false)
    expect(JSON.parse(expression)).toBe(value)
    expect(expression).not.toMatch(/[<>&'\u2028\u2029]/u)
  })

  it.each(
    [null, true, false, 42, ['fixture', false], { id: `a'b`, nested: ['<>&'] }].map(
      (value) => ({ value }),
    ),
  )('preserves a structured JSON value: $value', ({ value }) => {
    expect(runInNewContext(`(${smokeScriptValue(value)})`)).toEqual(value)
  })

  it('rejects a value that JSON cannot serialize before constructing code', () => {
    expect(() => smokeScriptValue(undefined)).toThrow(TypeError)
  })
})
