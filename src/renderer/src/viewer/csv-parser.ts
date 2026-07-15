export interface CsvTableData {
  readonly rows: readonly (readonly string[])[]
  readonly totalRows: number
  readonly truncated: boolean
}

const DEFAULT_MAX_ROWS = 500
const DEFAULT_MAX_COLUMNS = 100

/** RFC-4180-style parsing used only inside the CSV worker and unit tests. */
export function parseCsv(
  source: string,
  maxRows = DEFAULT_MAX_ROWS,
  maxColumns = DEFAULT_MAX_COLUMNS,
): CsvTableData {
  const rows: string[][] = []
  let totalRows = 0
  let row: string[] = []
  let field = ''
  let quoted = false

  const finishField = (): void => {
    if (row.length < maxColumns) row.push(field)
    field = ''
  }
  const finishRow = (): void => {
    finishField()
    totalRows += 1
    if (rows.length < maxRows) rows.push(row)
    row = []
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === ',') {
      finishField()
    } else if (character === '\n') {
      finishRow()
    } else if (character === '\r' && source[index + 1] === '\n') {
      finishRow()
      index += 1
    } else {
      field += character
    }
  }
  if (quoted) throw new Error('Unterminated quoted field')
  if (
    field.length > 0 ||
    row.length > 0 ||
    (source.length > 0 && !/[\r\n]$/.test(source))
  ) {
    finishRow()
  }
  return { rows, totalRows, truncated: totalRows > rows.length }
}
