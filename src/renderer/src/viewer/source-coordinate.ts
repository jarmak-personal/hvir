export interface SourceCoordinate {
  readonly line: number
  readonly column?: number
}

interface InvalidSourceCoordinate {
  readonly valid: false
  readonly message: string
}

export type ParsedSourceCoordinate =
  | { readonly valid: true; readonly coordinate: SourceCoordinate }
  | InvalidSourceCoordinate

export type ResolvedSourceCoordinate =
  | { readonly valid: true; readonly coordinate: SourceCoordinate; readonly offset: number }
  | InvalidSourceCoordinate

const COORDINATE = /^([1-9]\d*)(?::([1-9]\d*))?$/

export function parseSourceCoordinate(value: string): ParsedSourceCoordinate {
  const match = value.trim().match(COORDINATE)
  if (!match) return invalid('Enter a positive line or line:column')
  const line = Number(match[1])
  const column = match[2] === undefined ? undefined : Number(match[2])
  if (!Number.isSafeInteger(line) || (column !== undefined && !Number.isSafeInteger(column))) {
    return invalid('Line and column must be safe positive integers')
  }
  return {
    valid: true,
    coordinate: { line, ...(column === undefined ? {} : { column }) },
  }
}

export function resolveSourceCoordinate(
  content: string,
  coordinate: SourceCoordinate,
): ResolvedSourceCoordinate {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < content.length && line < coordinate.line; index += 1) {
    if (content.charCodeAt(index) !== 10) continue
    line += 1
    lineStart = index + 1
  }
  if (line !== coordinate.line) {
    return invalid(`Line ${coordinate.line} is outside this document`)
  }

  const newline = content.indexOf('\n', lineStart)
  let lineEnd = newline === -1 ? content.length : newline
  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1
  const column = coordinate.column ?? 1
  const maximumColumn = lineEnd - lineStart + 1
  if (column > maximumColumn) {
    return invalid(
      `Column ${column} is outside line ${coordinate.line} (maximum ${maximumColumn})`,
    )
  }
  return {
    valid: true,
    coordinate,
    offset: lineStart + column - 1,
  }
}

function invalid(message: string): InvalidSourceCoordinate {
  return { valid: false, message }
}
