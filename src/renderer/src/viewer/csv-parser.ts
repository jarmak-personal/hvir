export interface CsvTableData {
  readonly rows: readonly (readonly string[])[]
  readonly totalRows: number
  readonly totalColumns: number
  readonly truncated: boolean
  readonly columnsTruncated: boolean
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
  let totalColumns = 0
  let columnsTruncated = false
  let row: string[] = []
  let rowColumns = 0
  let field = ''
  let quoted = false

  const finishField = (): void => {
    if (row.length < maxColumns) row.push(field)
    rowColumns += 1
    field = ''
  }
  const finishRow = (): void => {
    finishField()
    totalRows += 1
    totalColumns = Math.max(totalColumns, rowColumns)
    if (rows.length < maxRows) {
      columnsTruncated ||= rowColumns > maxColumns
      rows.push(row)
    }
    row = []
    rowColumns = 0
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
  return {
    rows,
    totalRows,
    totalColumns,
    truncated: totalRows > rows.length,
    columnsTruncated,
  }
}
