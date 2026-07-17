import type { HarnessArgumentPart, HarnessProfileArgument } from '../../../shared'

const MAX_ARGUMENTS = 128

/**
 * Parse shell-shaped argv text without invoking a shell. Whitespace separates
 * arguments, quotes preserve whitespace, and backslash escapes one character.
 * Expansion, substitution, operators, and comments have no shell semantics.
 */
export function parseHarnessArguments(value: string): readonly HarnessProfileArgument[] {
  const tokens = tokenize(value)
  if (tokens.length > MAX_ARGUMENTS) {
    throw new Error('Harness profiles support at most ' + MAX_ARGUMENTS + ' arguments')
  }
  return tokens.map((token) => ({ parts: parseArgumentParts(token) }))
}

/** Canonical, round-trippable display form for persisted structured argv. */
export function serializeHarnessArguments(
  args: readonly HarnessProfileArgument[],
): string {
  return args
    .map((argument) => {
      const value = argument.parts.map(serializePart).join('')
      return quoteArgument(value)
    })
    .join(' ')
}

function tokenize(value: string): readonly string[] {
  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | undefined
  let escaped = false

  const finish = (): void => {
    if (!tokenStarted) return
    tokens.push(token)
    token = ''
    tokenStarted = false
  }

  for (const character of value) {
    if (escaped) {
      if (character === '\n' || character === '\r') {
        throw new Error('Arguments cannot escape across lines')
      }
      token += character
      tokenStarted = true
      escaped = false
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else if (quote === '"' && character === '\\') {
        escaped = true
      } else {
        if (character === '\n' || character === '\r') {
          throw new Error('Quoted arguments cannot span lines')
        }
        token += character
      }
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (character === '\\') {
      escaped = true
      tokenStarted = true
    } else if (/\s/.test(character)) {
      finish()
    } else {
      token += character
      tokenStarted = true
    }
  }

  if (escaped) throw new Error('Argument text ends with an incomplete escape')
  if (quote) throw new Error('Argument text has an unterminated ' + quote + ' quote')
  finish()
  return tokens
}

function serializePart(part: HarnessArgumentPart): string {
  if (part.kind === 'literal') return part.value
  if (part.source === 'projectRoot') return '{projectRoot}'
  if (part.source === 'workspaceRoot') return '{workspaceRoot}'
  return '{binding:' + (part.binding ?? '') + '}'
}

function quoteArgument(value: string): string {
  if (value === '') return "''"
  if (/^[a-zA-Z0-9_@%+=:,./{}-]+$/.test(value)) return value
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function parseArgumentParts(value: string): readonly HarnessArgumentPart[] {
  const parts: HarnessArgumentPart[] = []
  const pathToken =
    /\{(projectRoot|workspaceRoot|binding:([a-zA-Z][a-zA-Z0-9_-]{0,63}))\}/g
  let position = 0
  for (const match of value.matchAll(pathToken)) {
    if (match.index > position) {
      parts.push({ kind: 'literal', value: value.slice(position, match.index) })
    }
    const name = match[1]
    parts.push(
      name === 'projectRoot'
        ? { kind: 'path', source: 'projectRoot' }
        : name === 'workspaceRoot'
          ? { kind: 'path', source: 'workspaceRoot' }
          : { kind: 'path', source: 'binding', binding: match[2] },
    )
    position = match.index + match[0].length
  }
  if (position < value.length) {
    parts.push({ kind: 'literal', value: value.slice(position) })
  }
  const literal = parts
    .filter((part) => part.kind === 'literal')
    .map((part) => part.value)
    .join('')
  const unknown = literal.match(/\{[^{}]+\}/)
  if (unknown) throw new Error("Unknown path token '" + unknown[0] + "'")
  if (literal.includes('$') || literal.includes(String.fromCharCode(96))) {
    throw new Error('Shell interpolation is not supported in profile arguments')
  }
  return parts.length > 0 ? parts : [{ kind: 'literal', value: '' }]
}
